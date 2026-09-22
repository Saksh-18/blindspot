# server/tests/test_direct.py
import os
import sys
import dotenv
from groq import Groq

# Load server/.env file
env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
dotenv.load_dotenv(dotenv_path=env_path)

api_key = os.environ.get("GROQ_API_KEY")
print("Loaded GROQ_API_KEY:", api_key[:12] + "..." if api_key else "None")

client = Groq(api_key=api_key)
print("Sending test request to Groq SDK...")
try:
    completion = client.chat.completions.create(
        model="qwen/qwen3.8-27b",
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "List the JSON details for a greeting. Output only JSON format: {\"greeting\": \"hello\"}"},
                    {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="}},
                ],
            }
        ],
        temperature=0.2,
        max_completion_tokens=500,
        response_format={"type": "json_object"},
    )
    print("Connection Success!")
    print("Response Content:", completion.choices[0].message.content)
except Exception as e:
    print("Connection Failed!")
    import traceback
    traceback.print_exc()
