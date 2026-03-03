/*! jscanify ML Document Detector | MIT License */

/**
 * ML-based document detection using ONNX Runtime Web
 * 
 * This module provides neural network-based document detection
 * that works much better for handheld documents than traditional
 * edge detection.
 * 
 * Uses YOLOv8 or similar object detection model in ONNX format.
 */

(function (global, factory) {
  typeof exports === "object" && typeof module !== "undefined"
    ? (module.exports = factory())
    : typeof define === "function" && define.amd
      ? define(factory)
      : (global.MLDocumentDetector = factory());
})(this, function () {
  "use strict";

  // COCO class index for common document-like objects
  // You can train a custom model for better accuracy
  const DOCUMENT_CLASSES = [
    73,  // book
    84,  // book (alternative)
    // Add custom class IDs if using a fine-tuned model
  ];

  // Default configuration
  const DEFAULT_CONFIG = {
    modelPath: null,  // Path to ONNX model (user must provide)
    inputSize: 640,   // Model input size
    confidenceThreshold: 0.5,
    iouThreshold: 0.45,
    // For custom models, set to null to detect all classes
    targetClasses: null,
  };

  class MLDocumentDetector {
    constructor(config = {}) {
      this.config = { ...DEFAULT_CONFIG, ...config };
      this.session = null;
      this.isReady = false;
    }

    /**
     * Initialize the ONNX Runtime session with the model
     * @param {string} modelPath - Path to the ONNX model file
     */
    async initialize(modelPath) {
      if (!window.ort) {
        throw new Error('ONNX Runtime Web (ort) not loaded. Add: <script src="https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/ort.min.js"></script>');
      }

      const path = modelPath || this.config.modelPath;
      if (!path) {
        throw new Error('Model path is required');
      }

      try {
        // Configure ONNX Runtime
        ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/';
        
        // Create inference session
        this.session = await ort.InferenceSession.create(path, {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all',
        });

        this.isReady = true;
        console.log('ML Document Detector initialized');
        return true;
      } catch (error) {
        console.error('Failed to initialize ML detector:', error);
        throw error;
      }
    }

    /**
     * Detect documents in an image
     * @param {HTMLCanvasElement|HTMLImageElement|HTMLVideoElement} source - Image source
     * @returns {Promise<Array>} Array of detected documents with bounding boxes
     */
    async detect(source) {
      if (!this.isReady) {
        throw new Error('Detector not initialized. Call initialize() first.');
      }

      // Preprocess image
      const { tensor, originalWidth, originalHeight } = this._preprocessImage(source);

      // Run inference
      const feeds = { images: tensor };
      const results = await this.session.run(feeds);

      // Process outputs (format depends on model export settings)
      const detections = this._processOutputs(results, originalWidth, originalHeight);

      return detections;
    }

    /**
     * Detect and return corner points suitable for perspective correction
     * @param {HTMLCanvasElement|HTMLImageElement|HTMLVideoElement} source
     * @returns {Promise<Object|null>} Corner points or null if no document detected
     */
    async detectCorners(source) {
      const detections = await this.detect(source);
      
      if (detections.length === 0) {
        return null;
      }

      // Get the detection with highest confidence
      const best = detections[0];
      
      // Convert bounding box to corner points
      // Note: This gives rectangular corners; for better results,
      // you'd want a segmentation model that outputs actual corners
      return {
        topLeftCorner: { x: best.x1, y: best.y1 },
        topRightCorner: { x: best.x2, y: best.y1 },
        bottomLeftCorner: { x: best.x1, y: best.y2 },
        bottomRightCorner: { x: best.x2, y: best.y2 },
        confidence: best.confidence,
        bbox: best,
      };
    }

    /**
     * Preprocess image for model input
     * @private
     */
    _preprocessImage(source) {
      const inputSize = this.config.inputSize;
      
      // Create canvas for preprocessing
      const canvas = document.createElement('canvas');
      canvas.width = inputSize;
      canvas.height = inputSize;
      const ctx = canvas.getContext('2d');

      // Get original dimensions
      let originalWidth, originalHeight;
      if (source instanceof HTMLVideoElement) {
        originalWidth = source.videoWidth;
        originalHeight = source.videoHeight;
      } else if (source instanceof HTMLCanvasElement) {
        originalWidth = source.width;
        originalHeight = source.height;
      } else {
        originalWidth = source.naturalWidth || source.width;
        originalHeight = source.naturalHeight || source.height;
      }

      // Calculate scaling to maintain aspect ratio
      const scale = Math.min(inputSize / originalWidth, inputSize / originalHeight);
      const scaledWidth = Math.round(originalWidth * scale);
      const scaledHeight = Math.round(originalHeight * scale);
      const offsetX = Math.round((inputSize - scaledWidth) / 2);
      const offsetY = Math.round((inputSize - scaledHeight) / 2);

      // Fill with gray (padding)
      ctx.fillStyle = '#808080';
      ctx.fillRect(0, 0, inputSize, inputSize);

      // Draw scaled image centered
      ctx.drawImage(source, offsetX, offsetY, scaledWidth, scaledHeight);

      // Get image data and convert to tensor
      const imageData = ctx.getImageData(0, 0, inputSize, inputSize);
      const { data } = imageData;

      // Convert to NCHW format (batch, channels, height, width)
      // Normalize to 0-1 range
      const tensorData = new Float32Array(3 * inputSize * inputSize);
      
      for (let i = 0; i < inputSize * inputSize; i++) {
        tensorData[i] = data[i * 4] / 255.0;                    // R
        tensorData[inputSize * inputSize + i] = data[i * 4 + 1] / 255.0;  // G
        tensorData[2 * inputSize * inputSize + i] = data[i * 4 + 2] / 255.0; // B
      }

      const tensor = new ort.Tensor('float32', tensorData, [1, 3, inputSize, inputSize]);

      // Store preprocessing info for coordinate conversion
      this._preprocessInfo = { scale, offsetX, offsetY, originalWidth, originalHeight };

      return { tensor, originalWidth, originalHeight };
    }

    /**
     * Process model outputs into detection results
     * @private
     */
    _processOutputs(outputs, originalWidth, originalHeight) {
      // Get output tensor (format depends on model)
      // YOLOv8 typically outputs [1, 84, 8400] for COCO (80 classes + 4 bbox)
      // or [1, N, 6] with built-in NMS (x1, y1, x2, y2, confidence, class)
      
      const outputName = Object.keys(outputs)[0];
      const output = outputs[outputName];
      const data = output.data;
      const dims = output.dims;

      const detections = [];
      const { scale, offsetX, offsetY } = this._preprocessInfo;
      const inputSize = this.config.inputSize;

      // Handle different output formats
      if (dims.length === 3 && dims[2] === 6) {
        // Format: [1, N, 6] - (x1, y1, x2, y2, confidence, class)
        const numDetections = dims[1];
        
        for (let i = 0; i < numDetections; i++) {
          const offset = i * 6;
          const confidence = data[offset + 4];
          
          if (confidence < this.config.confidenceThreshold) continue;
          
          const classId = Math.round(data[offset + 5]);
          
          // Filter by target classes if specified
          if (this.config.targetClasses && 
              !this.config.targetClasses.includes(classId)) continue;

          // Convert coordinates back to original image space
          let x1 = (data[offset] - offsetX) / scale;
          let y1 = (data[offset + 1] - offsetY) / scale;
          let x2 = (data[offset + 2] - offsetX) / scale;
          let y2 = (data[offset + 3] - offsetY) / scale;

          // Clamp to image bounds
          x1 = Math.max(0, Math.min(originalWidth, x1));
          y1 = Math.max(0, Math.min(originalHeight, y1));
          x2 = Math.max(0, Math.min(originalWidth, x2));
          y2 = Math.max(0, Math.min(originalHeight, y2));

          detections.push({
            x1, y1, x2, y2,
            confidence,
            classId,
            width: x2 - x1,
            height: y2 - y1,
          });
        }
      } else if (dims.length === 3) {
        // Format: [1, 84, 8400] - raw YOLOv8 output (needs NMS)
        // This is more complex - implement basic NMS
        detections.push(...this._processRawYoloOutput(data, dims, originalWidth, originalHeight));
      }

      // Sort by confidence
      detections.sort((a, b) => b.confidence - a.confidence);

      return detections;
    }

    /**
     * Process raw YOLOv8 output format [1, 84, 8400]
     * @private
     */
    _processRawYoloOutput(data, dims, originalWidth, originalHeight) {
      const numClasses = dims[1] - 4;  // 84 - 4 = 80 classes for COCO
      const numBoxes = dims[2];        // 8400
      const { scale, offsetX, offsetY } = this._preprocessInfo;
      
      const candidates = [];

      for (let i = 0; i < numBoxes; i++) {
        // Get bbox (cx, cy, w, h)
        const cx = data[0 * numBoxes + i];
        const cy = data[1 * numBoxes + i];
        const w = data[2 * numBoxes + i];
        const h = data[3 * numBoxes + i];

        // Find best class
        let maxConf = 0;
        let maxClass = 0;
        for (let c = 0; c < numClasses; c++) {
          const conf = data[(4 + c) * numBoxes + i];
          if (conf > maxConf) {
            maxConf = conf;
            maxClass = c;
          }
        }

        if (maxConf < this.config.confidenceThreshold) continue;

        // Filter by target classes if specified
        if (this.config.targetClasses && 
            !this.config.targetClasses.includes(maxClass)) continue;

        // Convert to corner format and original image space
        let x1 = ((cx - w / 2) - offsetX) / scale;
        let y1 = ((cy - h / 2) - offsetY) / scale;
        let x2 = ((cx + w / 2) - offsetX) / scale;
        let y2 = ((cy + h / 2) - offsetY) / scale;

        // Clamp to image bounds
        x1 = Math.max(0, Math.min(originalWidth, x1));
        y1 = Math.max(0, Math.min(originalHeight, y1));
        x2 = Math.max(0, Math.min(originalWidth, x2));
        y2 = Math.max(0, Math.min(originalHeight, y2));

        candidates.push({
          x1, y1, x2, y2,
          confidence: maxConf,
          classId: maxClass,
          width: x2 - x1,
          height: y2 - y1,
        });
      }

      // Apply NMS
      return this._nms(candidates, this.config.iouThreshold);
    }

    /**
     * Non-Maximum Suppression
     * @private
     */
    _nms(boxes, iouThreshold) {
      // Sort by confidence
      boxes.sort((a, b) => b.confidence - a.confidence);

      const kept = [];
      const suppressed = new Set();

      for (let i = 0; i < boxes.length; i++) {
        if (suppressed.has(i)) continue;

        kept.push(boxes[i]);

        for (let j = i + 1; j < boxes.length; j++) {
          if (suppressed.has(j)) continue;

          const iou = this._calculateIoU(boxes[i], boxes[j]);
          if (iou > iouThreshold) {
            suppressed.add(j);
          }
        }
      }

      return kept;
    }

    /**
     * Calculate Intersection over Union
     * @private
     */
    _calculateIoU(box1, box2) {
      const x1 = Math.max(box1.x1, box2.x1);
      const y1 = Math.max(box1.y1, box2.y1);
      const x2 = Math.min(box1.x2, box2.x2);
      const y2 = Math.min(box1.y2, box2.y2);

      const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
      const area1 = box1.width * box1.height;
      const area2 = box2.width * box2.height;
      const union = area1 + area2 - intersection;

      return intersection / union;
    }

    /**
     * Draw detection results on a canvas
     * @param {CanvasRenderingContext2D} ctx - Canvas context
     * @param {Array} detections - Detection results from detect()
     */
    drawDetections(ctx, detections) {
      for (const det of detections) {
        // Draw bounding box
        ctx.strokeStyle = '#00ff00';
        ctx.lineWidth = 3;
        ctx.strokeRect(det.x1, det.y1, det.width, det.height);

        // Draw corner points
        ctx.fillStyle = '#00ff00';
        const corners = [
          [det.x1, det.y1],
          [det.x2, det.y1],
          [det.x1, det.y2],
          [det.x2, det.y2],
        ];
        for (const [x, y] of corners) {
          ctx.beginPath();
          ctx.arc(x, y, 8, 0, Math.PI * 2);
          ctx.fill();
        }

        // Draw label
        const label = `Doc: ${(det.confidence * 100).toFixed(1)}%`;
        ctx.fillStyle = 'rgba(0, 255, 0, 0.8)';
        ctx.fillRect(det.x1, det.y1 - 25, ctx.measureText(label).width + 10, 25);
        ctx.fillStyle = '#000';
        ctx.font = '16px sans-serif';
        ctx.fillText(label, det.x1 + 5, det.y1 - 7);
      }
    }
  }

  return MLDocumentDetector;
});
