"""
Measures detection + redaction quality against a labeled set of sample
screenshots (eval/sample_screens/), where each screenshot has a ground-truth
JSON listing the sensitive regions (bounding boxes + type: face/password/
card-number/etc).

Two separate numbers, matching the two separate judging criteria:
  - detection precision/recall: did we find the right regions? (20%)
  - redaction precision: of what we redacted, how tightly/correctly? i.e.
    penalize over-redaction (blacking out half the page) as well as
    under-redaction (missing part of a region). (20%)

TODO: define the ground-truth label format, drop labeled samples into
sample_screens/, then implement IoU-based matching here.
"""

if __name__ == "__main__":
    print("TODO: implement once sample_screens/ has labeled ground truth.")
