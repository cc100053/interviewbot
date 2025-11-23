import sys
import os

print(f"Python Executable: {sys.executable}")
print(f"Python Version: {sys.version}")

try:
    import jwt
    print(f"SUCCESS: jwt module found at {jwt.__file__}")
    print(f"jwt version: {jwt.__version__}")
except ImportError as e:
    print(f"ERROR: {e}")
except AttributeError:
    print("WARNING: jwt module found but might be the wrong one (no __version__ or __file__)")

try:
    import uvicorn
    print(f"SUCCESS: uvicorn module found at {uvicorn.__file__}")
except ImportError:
    print("ERROR: uvicorn module NOT found")
