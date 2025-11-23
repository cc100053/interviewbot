from datetime import datetime, timedelta
from typing import Optional

import bcrypt
import jwt
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, constr

from app.dependencies import get_app_settings, get_db_service
from app.services.db import DatabaseService
from config.settings import Settings


class AuthRequest(BaseModel):  #このクラスは Pydantic のモデルと宣言
    user_id: str = Field(..., alias="userId") #user_idの形の検証と、frontendから受けたuserIdをbackendのuser_idに自動翻訳。
    password: constr(min_length=8)  # type: ignore[valid-type]

    class Config:
        allow_population_by_field_name = True


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


router = APIRouter(prefix="/auth", tags=["auth"])

ACCESS_TOKEN_EXPIRE_MINUTES = 60


def _sanitize_user_id(raw_user_id: str) -> str:
    user_id = raw_user_id.strip()
    if not user_id or " " in user_id:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Invalid user ID",
        )
    return user_id


def _hash_password(raw_password: str) -> str:
    """Hash a password for storage."""
    hashed = bcrypt.hashpw(raw_password.encode("utf-8"), bcrypt.gensalt())
    return hashed.decode("utf-8")


def _verify_password(raw_password: str, hashed_password: str) -> bool:
    """Validate a password against a hash."""
    return bcrypt.checkpw(
        raw_password.encode("utf-8"),
        hashed_password.encode("utf-8"),
    )


def _create_access_token(
    *,
    subject: str,
    settings: Settings,
    expires_delta: Optional[timedelta] = None,
) -> str:
    """Generate a signed JWT access token."""
    expire = datetime.utcnow() + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    payload = {"sub": subject, "exp": expire}
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def _issue_token_for_user(user_id: str, settings: Settings) -> TokenResponse:
    token = _create_access_token(subject=user_id, settings=settings)
    return TokenResponse(access_token=token)


def _ensure_user_does_not_exist(db: DatabaseService, user_id: str) -> None:
    if db.get_user(user_id):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="User already exists",
        )


def _get_user_or_unauthorized(db: DatabaseService, user_id: str, password: str) -> dict:
    user = db.get_user(user_id)
    if not user or not _verify_password(password, user["password_hash"]):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid user ID or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


@router.post("/signup", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
async def signup(
    request: AuthRequest,
    db: DatabaseService = Depends(get_db_service),
    settings: Settings = Depends(get_app_settings),
) -> TokenResponse:
    """Register a new user and issue an access token."""
    user_id = _sanitize_user_id(request.user_id)
    _ensure_user_does_not_exist(db, user_id)

    password_hash = _hash_password(request.password)
    try:
        db.create_user(user_id=user_id, password_hash=password_hash)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="User already exists",
        ) from None

    return _issue_token_for_user(user_id, settings)


@router.post("/login", response_model=TokenResponse)
async def login(
    request: AuthRequest,
    db: DatabaseService = Depends(get_db_service),
    settings: Settings = Depends(get_app_settings),
) -> TokenResponse:
    """Authenticate a user and return a new access token."""
    user_id = _sanitize_user_id(request.user_id)
    _get_user_or_unauthorized(db, user_id, request.password)
    return _issue_token_for_user(user_id, settings)
