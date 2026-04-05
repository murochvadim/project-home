#!/usr/bin/env python3
"""
Compute InsightFace ArcFace embedding for a single crop image.
Usage: embed_crop.py <crop_path>
Outputs: JSON array of 512 floats, or {"error": "..."} on failure.
Called as subprocess by player_service so model memory is isolated.
"""
import sys, json
import cv2
import numpy as np
from insightface.app import FaceAnalysis

if len(sys.argv) < 2:
    print(json.dumps({'error': 'usage: embed_crop.py <crop_path>'}))
    sys.exit(1)

crop_path = sys.argv[1]
try:
    img = cv2.imread(crop_path)
    if img is None:
        print(json.dumps({'error': 'cannot read crop image'}))
        sys.exit(1)
    img_112 = cv2.resize(img, (112, 112))

    app = FaceAnalysis(name='buffalo_l', providers=['CPUExecutionProvider'])
    app.prepare(ctx_id=-1, det_size=(640, 640))
    rec = app.models.get('recognition')
    if rec is None:
        print(json.dumps({'error': 'recognition model not found'}))
        sys.exit(1)

    feat = rec.get_feat(img_112)
    emb  = (feat[0] if feat.ndim == 2 else feat).tolist()
    print(json.dumps(emb))
except Exception as e:
    print(json.dumps({'error': str(e)}))
    sys.exit(1)
