from functools import lru_cache
from pathlib import Path
from typing import Optional

try:  # pragma: no cover - prefer modern package when available
    from pydantic_settings import BaseSettings  # type: ignore
    from pydantic import Field  # type: ignore
except ImportError:  # pragma: no cover - fallback to pydantic v1 compatibility layer
    from pydantic.v1 import BaseSettings, Field  # type: ignore


class Settings(BaseSettings):
    """Centralised application configuration."""

    app_env: str = Field("development", env="APP_ENV")
    jwt_secret: str = Field("change-me", env="JWT_SECRET")
    jwt_algorithm: str = Field("HS256", env="JWT_ALGORITHM")

    sqlite_db_path: Optional[str] = Field(None, env="SQLITE_DB_PATH")

    cosmos_account_uri: Optional[str] = Field(None, env="COSMOS_ACCOUNT_URI")
    cosmos_account_key: Optional[str] = Field(None, env="COSMOS_ACCOUNT_KEY")
    cosmos_database_name: str = Field("ai_interview", env="COSMOS_DATABASE_NAME")
    cosmos_users_container: str = Field("users", env="COSMOS_USERS_CONTAINER")
    cosmos_interviews_container: str = Field("interviews", env="COSMOS_INTERVIEWS_CONTAINER")
    cosmos_users_partition_key: str = Field("/email", env="COSMOS_USERS_PARTITION_KEY")
    cosmos_interviews_partition_key: str = Field("/userId", env="COSMOS_INTERVIEWS_PARTITION_KEY")
    use_in_memory_db: bool = Field(False, env="USE_IN_MEMORY_DB")

    azure_speech_key: Optional[str] = Field(None, env="AZURE_SPEECH_KEY")
    azure_speech_region: Optional[str] = Field(None, env="AZURE_SPEECH_REGION")
    azure_speech_voice: Optional[str] = Field(None, env="AZURE_SPEECH_VOICE")

    gemini_api_key: Optional[str] = Field(None, env="GEMINI_API_KEY")
    gemini_model_name: str = Field("models/gemini-1.5-flash-latest", env="GEMINI_MODEL_NAME")

    class Config:
        env_file = Path(".env")
        env_file_encoding = "utf-8"


@lru_cache()
def get_settings() -> Settings:
    """Return a cached Settings instance."""
    return Settings()
