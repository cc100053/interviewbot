"""Gemini API key manager with round-robin rotation."""

import logging
import threading
from typing import List, Optional

logger = logging.getLogger(__name__)


class GeminiKeyManager:
    """Manages multiple Gemini API keys with round-robin rotation.

    Thread-safe: safe to use across multiple requests.
    """

    def __init__(self, keys: List[str]) -> None:
        """Initialize with a list of API keys.

        Args:
            keys: List of valid API keys. Empty keys will be filtered out.
        """
        self._keys = [k.strip() for k in keys if k and k.strip()]
        self._index = 0
        self._lock = threading.Lock()

        if not self._keys:
            logger.warning("GeminiKeyManager initialized with no valid keys.")

    @property
    def key_count(self) -> int:
        """Return the number of available keys."""
        return len(self._keys)

    def get_current_key(self) -> Optional[str]:
        """Return the current key without advancing the index."""
        if not self._keys:
            return None
        with self._lock:
            return self._keys[self._index]

    def get_next_key(self) -> Optional[str]:
        """Advance to the next key and return it (round-robin).

        Returns:
            The next API key, or None if no keys are available.
        """
        if not self._keys:
            return None
        with self._lock:
            self._index = (self._index + 1) % len(self._keys)
            key = self._keys[self._index]
            logger.info("Rotated to Gemini API key index %d", self._index)
            return key

    def get_current_index(self) -> int:
        """Return the current key index."""
        with self._lock:
            return self._index
