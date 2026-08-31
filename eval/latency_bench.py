# eval/latency_bench.py
# Measures end-to-end latency of one agent step, broken down by stage.

import urllib.request
import json

SERVER_REPORT_URL = "http://localhost:8000/eval/report"

def main():
    try:
        with urllib.request.urlopen(SERVER_REPORT_URL) as response:
            if response.status != 200:
                print(f"Error: Server returned status code {response.status}")
                return
            data = json.loads(response.read().decode())
    except Exception as e:
        print(f"Could not connect to FastAPI server at {SERVER_REPORT_URL}: {e}")
        print("Please make sure the server is running and the extension has executed some steps.")
        return

    if not data:
        print("No telemetry runs recorded yet.")
        print("Navigate in Chrome, run a task with the extension, and run this benchmark again.")
        return

    print("=" * 90)
    print("                       Privacy-Preserving Vision Agent Telemetry Run Results")
    print("=" * 90)
    print(f"Total steps measured: {len(data)}")
    print("-" * 90)
    print(f"{'Phase / Stage':<35} | {'Average (ms)':<12} | {'Min (ms)':<10} | {'Max (ms)':<10}")
    print("-" * 90)

    stages = [
        ("sanitizeDomMs", "DOM Sanitization (PII check)"),
        ("findTextPiiMs", "DOM Text Search (PII Regex)"),
        ("captureVisibleTabMs", "Tab Screenshot Capture"),
        ("detectSensitiveRegionsMs", "Local Face Model Inference"),
        ("redactImageMs", "Image Redaction (Blur/Canvas)"),
        ("serverRoundTripMs", "Server VLM API Roundtrip"),
        ("executeMs", "Action Execution in DOM"),
        ("totalStepMs", "Total End-to-End Step Time")
    ]

    for key, label in stages:
        vals = [run.get(key, 0) for run in data]
        if not vals:
            continue
        avg_val = sum(vals) / len(vals)
        min_val = min(vals)
        max_val = max(vals)
        print(f"{label:<35} | {avg_val:<12.1f} | {min_val:<10.1f} | {max_val:<10.1f}")

    print("-" * 90)
    redaction_reports = [run.get("redactionReport", {}) for run in data]
    total_dom_redact = sum(r.get("domFieldsRedacted", 0) for r in redaction_reports)
    total_text_redact = sum(r.get("textPiiRedacted", 0) for r in redaction_reports)
    total_visual_redact = sum(r.get("visualRegionsRedacted", 0) for r in redaction_reports)

    print(f"Entities Redacted Across Runs:")
    print(f"  - DOM Fields:    {total_dom_redact}")
    print(f"  - Text Regex:    {total_text_redact}")
    print(f"  - Faces (Model): {total_visual_redact}")
    print("=" * 90)

if __name__ == "__main__":
    main()
