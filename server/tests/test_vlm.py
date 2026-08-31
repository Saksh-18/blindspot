# server/tests/test_vlm.py
import os
import sys
import asyncio
from dotenv import load_dotenv

# Add parent split path to Python sys.path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
load_dotenv(dotenv_path=env_path)

from schemas import AgentStepRequest
from vlm_client import get_next_action

async def run_test():
    req = AgentStepRequest(
        task="Test task",
        image="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        dom=[]
    )
    print("Sending test request to VLM...")
    try:
        res = await get_next_action(req)
        print("Success:", res)
    except Exception as e:
        print("Error details:", e)
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    asyncio.run(run_test())
