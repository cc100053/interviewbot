---
description: Setup python environment and run the server
---
1. Rename the environment file (if not already done)
   ```bash
   mv env .env
   ```

2. Create a virtual environment
   ```bash
   python3 -m venv .venv
   ```

3. Activate the virtual environment
   ```bash
   source .venv/bin/activate
   ```

4. Install dependencies
   ```bash
   pip install -r requirements.txt
   ```

5. Run the server
   ```bash
   uvicorn app.main:app --reload
   ```
