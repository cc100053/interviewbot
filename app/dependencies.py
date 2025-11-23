import logging
from functools import lru_cache
from typing import Optional

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer

from app.services.ai import AIService
from app.services.db import (
    CosmosDatabaseService,
    DatabaseService,
    InMemoryDatabaseService,
    SQLiteDatabaseService,
)
from config.settings import Settings, get_settings

logger = logging.getLogger(__name__)

_oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")


def _is_placeholder(value: Optional[str]) -> bool:
    if value is None:
        return True
    stripped = value.strip()
    if not stripped:
        return True
    placeholder_tokens = ("your-account", "your-primary-or-secondary-key", "change-me")
    return any(token in stripped for token in placeholder_tokens)


def _initialise_db_service(settings: Settings) -> DatabaseService:
    if settings.use_in_memory_db:
        logger.info("Using in-memory DB service (forced via USE_IN_MEMORY_DB)")
        return InMemoryDatabaseService()

    if settings.sqlite_db_path:
        logger.info("Using SQLite DB at %s", settings.sqlite_db_path)
        return SQLiteDatabaseService(settings.sqlite_db_path)

    if not _is_placeholder(settings.cosmos_account_uri) and not _is_placeholder(settings.cosmos_account_key):
        try:
            logger.info("Initialising Cosmos DB service")
            return CosmosDatabaseService(settings)
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("Falling back to in-memory DB service: %s", exc)

    logger.info("Using in-memory DB service")
    return InMemoryDatabaseService()


@lru_cache
def _get_cached_db_service() -> DatabaseService:
    settings = get_settings()
    return _initialise_db_service(settings)


@lru_cache
def _get_cached_ai_service() -> AIService:
    return AIService()


def get_db_service() -> DatabaseService:
    """Provide a singleton database service instance."""
    return _get_cached_db_service()


def get_ai_service() -> AIService:
    """Provide a singleton AI service instance."""
    return _get_cached_ai_service()


def get_app_settings() -> Settings:
    """Expose application settings for dependency injection."""
    return get_settings()


def _credentials_exception() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )


def _decode_token(token: str, settings: Settings) -> Optional[str]:
    try:
        payload = jwt.decode(
            token,
            settings.jwt_secret,
            algorithms=[settings.jwt_algorithm],
        )
    except jwt.PyJWTError as exc:  # pragma: no cover - defensive
        raise _credentials_exception() from exc
    return payload.get("sub")


def get_current_user(
    token: str = Depends(_oauth2_scheme),
    settings: Settings = Depends(get_app_settings),
    db: DatabaseService = Depends(get_db_service),
):
    """Decode JWT token and fetch the associated user."""
    user_id = _decode_token(token, settings)
    if not user_id:
        raise _credentials_exception()

    user = db.get_user(user_id)
    if user is None:
        raise _credentials_exception()

    return user
