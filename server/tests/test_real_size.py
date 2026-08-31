# server/tests/test_real_size.py
import os
import io
import base64
import sys
import dotenv
from PIL import Image
from groq import Groq

env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
dotenv.load_dotenv(dotenv_path=env_path)

api_key = os.environ.get("GROQ_API_KEY")
client = Groq(api_key=api_key)

print("Creating a 400x300 red test image...")
img = Image.new("RGB", (400, 300), color="red")

# Save as PNG
png_buf = io.BytesIO()
img.save(png_buf, format="PNG")
png_base64 = base64.b64encode(png_buf.getvalue()).decode("utf-8")
png_data_url = f"data:image/png;base64,{png_base64}"

# Save as JPEG
jpeg_buf = io.BytesIO()
img.save(jpeg_buf, format="JPEG")
jpeg_base64 = base64.b64encode(jpeg_buf.getvalue()).decode("utf-8")
jpeg_data_url = f"data:image/jpeg;base64,{jpeg_base64}"

def test_image(data_url, name):
    print(f"\n--- Testing with {name} image ---")
    try:
        completion = client.chat.completions.create(
            model="qwen/qwen3.6-27b",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "Describe the main color of this image in a JSON: {\"color\": \"<color>\"}"},
                        {"type": "image_url", "image_url": {"url": data_url}},
                    ],
                }
            ],
            temperature=0.2,
            max_completion_tokens=500,
            response_format={"type": "json_object"},
        )
        print(f"Success for {name}!")
        print("Response:", completion.choices[0].message.content)
    except Exception as e:
        print(f"Failed for {name}!")
        import traceback
        traceback.print_exc()

test_image(png_data_url, "PNG")
test_image(jpeg_data_url, "JPEG")
