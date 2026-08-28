"""
Measures end-to-end latency of one agent step, broken down by stage:
  capture -> local detect -> redact -> network -> server inference -> execute

Run this against a fixed set of sample tasks/pages once the pipeline is wired
up. Output: a table (or JSON) of per-stage ms, so you can point at exactly
where time is going for the "overall end-to-end latency" (15%) and
"client-side resource utilization" (20%) criteria.

TODO: instrument background.js to emit timestamps at each stage (e.g. via
chrome.runtime messages or console timestamps captured from a test harness
like Puppeteer), then parse them here.
"""

STAGES = ["capture", "local_detect", "redact", "network_send", "server_inference", "execute"]

if __name__ == "__main__":
    print("TODO: wire up timing capture from the extension, then report per-stage latency.")
