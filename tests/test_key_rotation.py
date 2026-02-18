"""Unit tests for API key rotation and retry logic."""

import types
from unittest.mock import MagicMock, patch, call

import pytest

from app.services.key_manager import GeminiKeyManager


# ---------------------------------------------------------------------------
# GeminiKeyManager tests
# ---------------------------------------------------------------------------

class TestGeminiKeyManager:
    """Tests for GeminiKeyManager round-robin + retry helpers."""

    def test_round_robin_basic(self):
        mgr = GeminiKeyManager(["k0", "k1", "k2"])
        assert mgr.get_current_key() == "k0"
        assert mgr.get_next_key() == "k1"
        assert mgr.get_next_key() == "k2"
        assert mgr.get_next_key() == "k0"  # wraps

    def test_get_keys_cycle_from_next(self):
        mgr = GeminiKeyManager(["A", "B", "C"])
        # starts at index 0 → cycle should start at 1
        result = mgr.get_keys_cycle_from_next()
        assert result == [(1, "B"), (2, "C"), (0, "A")]

    def test_get_keys_cycle_after_advance(self):
        mgr = GeminiKeyManager(["A", "B", "C"])
        mgr.get_next_key()  # now at index 1
        result = mgr.get_keys_cycle_from_next()
        assert result == [(2, "C"), (0, "A"), (1, "B")]

    def test_set_index(self):
        mgr = GeminiKeyManager(["A", "B", "C"])
        mgr.set_index(2)
        assert mgr.get_current_key() == "C"
        assert mgr.get_current_index() == 2

    def test_single_key(self):
        mgr = GeminiKeyManager(["only"])
        result = mgr.get_keys_cycle_from_next()
        assert result == [(0, "only")]

    def test_empty_keys(self):
        mgr = GeminiKeyManager([])
        assert mgr.key_count == 0
        assert mgr.get_keys_cycle_from_next() == []


# ---------------------------------------------------------------------------
# AIService._call_gemini tests
# ---------------------------------------------------------------------------

class TestCallGemini:
    """Tests for the _call_gemini wrapper with mocked Gemini SDK."""

    def _make_ai_service(self, keys: list[str]):
        """Create a minimal AIService-like object with mocked deps."""
        from app.services.key_manager import GeminiKeyManager

        svc = types.SimpleNamespace()
        svc.use_gemini = True
        svc.key_manager = GeminiKeyManager(keys)
        svc.settings = types.SimpleNamespace(gemini_model_name="models/test-model")
        svc.generative_model = MagicMock()

        # Bind _call_gemini and _extract_plain_text from the real class
        from app.services.ai import AIService
        svc._call_gemini = AIService._call_gemini.__get__(svc, type(svc))
        svc._extract_plain_text = AIService._extract_plain_text
        return svc

    @patch("app.services.ai.genai")
    def test_rotates_key_on_success(self, mock_genai):
        """First call should use the *next* key (round-robin from 0 → key at index 1)."""
        svc = self._make_ai_service(["k0", "k1", "k2"])

        mock_response = MagicMock()
        mock_response.text = "hello"
        mock_model = MagicMock()
        mock_model.generate_content.return_value = mock_response
        mock_genai.GenerativeModel.return_value = mock_model

        result = svc._call_gemini("test prompt")
        assert result == "hello"
        # Should have configured with key at index 1 (next after 0)
        mock_genai.configure.assert_called_once_with(api_key="k1")
        # Key index should now be 1
        assert svc.key_manager.get_current_index() == 1

    @patch("app.services.ai.genai")
    def test_retries_on_failure_then_succeeds(self, mock_genai):
        """First key fails, second key succeeds."""
        svc = self._make_ai_service(["k0", "k1", "k2"])

        mock_response = MagicMock()
        mock_response.text = "success"
        mock_model_fail = MagicMock()
        mock_model_fail.generate_content.side_effect = Exception("rate limited")
        mock_model_ok = MagicMock()
        mock_model_ok.generate_content.return_value = mock_response

        # First GenerativeModel call fails, second succeeds
        mock_genai.GenerativeModel.side_effect = [mock_model_fail, mock_model_ok]

        result = svc._call_gemini("test prompt")
        assert result == "success"
        # Should have tried k1 (failed), then k2 (succeeded)
        assert mock_genai.configure.call_count == 2
        mock_genai.configure.assert_any_call(api_key="k1")
        mock_genai.configure.assert_any_call(api_key="k2")
        assert svc.key_manager.get_current_index() == 2

    @patch("app.services.ai.genai")
    def test_all_keys_exhausted_raises(self, mock_genai):
        """All keys fail → should raise the last exception."""
        svc = self._make_ai_service(["k0", "k1"])

        mock_model = MagicMock()
        mock_model.generate_content.side_effect = Exception("rate limited")
        mock_genai.GenerativeModel.return_value = mock_model

        with pytest.raises(Exception, match="rate limited"):
            svc._call_gemini("test prompt")

        # Should have tried both keys
        assert mock_genai.configure.call_count == 2

    @patch("app.services.ai.genai")
    def test_consecutive_calls_use_different_keys(self, mock_genai):
        """Two consecutive calls should use different keys."""
        svc = self._make_ai_service(["k0", "k1", "k2"])

        mock_response = MagicMock()
        mock_response.text = "ok"
        mock_model = MagicMock()
        mock_model.generate_content.return_value = mock_response
        mock_genai.GenerativeModel.return_value = mock_model

        svc._call_gemini("prompt 1")
        svc._call_gemini("prompt 2")
        svc._call_gemini("prompt 3")

        # Keys should rotate: k1, k2, k0
        configure_calls = mock_genai.configure.call_args_list
        assert configure_calls[0] == call(api_key="k1")
        assert configure_calls[1] == call(api_key="k2")
        assert configure_calls[2] == call(api_key="k0")
