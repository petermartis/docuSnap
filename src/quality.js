/*! jscanify Quality Assessment Module | MIT License */

(function (global, factory) {
  typeof exports === "object" && typeof module !== "undefined"
    ? (module.exports = factory())
    : typeof define === "function" && define.amd
      ? define(factory)
      : (global.QualityAssessment = factory());
})(this, function () {
  "use strict";

  /**
   * Quality assessment thresholds with sensible defaults for ID/passport capture
   */
  const DEFAULT_THRESHOLDS = {
    // Sharpness: Laplacian variance threshold (higher = sharper required)
    sharpness: {
      min: 100,        // Minimum acceptable sharpness
      good: 200,       // Good quality threshold
    },
    // Glare: Maximum percentage of overexposed pixels allowed
    glare: {
      maxOverexposedRatio: 0.02,  // Max 2% overexposed pixels
      brightnessThreshold: 250,   // Pixel value considered overexposed
    },
    // Document detection: Minimum area ratio of detected document to frame
    document: {
      minAreaRatio: 0.15,         // Document should be at least 15% of frame
      maxAreaRatio: 0.85,         // Document should be at most 85% of frame
      minAspectRatio: 1.2,        // Minimum width/height ratio (portrait ID)
      maxAspectRatio: 1.8,        // Maximum width/height ratio (landscape ID)
    },
    // Corner detection: All 4 corners must be detected
    corners: {
      required: true,
    },
  };

  class QualityAssessment {
    constructor(options = {}) {
      this.thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
    }

    /**
     * Calculates sharpness score using Laplacian variance method.
     * Higher values indicate sharper images.
     * @param {cv.Mat} img - Input image (can be color or grayscale)
     * @returns {number} Sharpness score (Laplacian variance)
     */
    calculateSharpness(img) {
      const gray = new cv.Mat();
      const laplacian = new cv.Mat();
      
      // Convert to grayscale if needed
      if (img.channels() > 1) {
        cv.cvtColor(img, gray, cv.COLOR_RGBA2GRAY);
      } else {
        img.copyTo(gray);
      }

      // Apply Laplacian operator
      cv.Laplacian(gray, laplacian, cv.CV_64F);

      // Calculate variance (measure of sharpness)
      const mean = new cv.Mat();
      const stddev = new cv.Mat();
      cv.meanStdDev(laplacian, mean, stddev);
      
      const variance = Math.pow(stddev.data64F[0], 2);

      // Cleanup
      gray.delete();
      laplacian.delete();
      mean.delete();
      stddev.delete();

      return variance;
    }

    /**
     * Detects glare/overexposed regions in the image.
     * @param {cv.Mat} img - Input image
     * @returns {Object} Glare analysis result with ratio and hasGlare flag
     */
    detectGlare(img) {
      const gray = new cv.Mat();
      const threshold = this.thresholds.glare.brightnessThreshold;
      
      // Convert to grayscale if needed
      if (img.channels() > 1) {
        cv.cvtColor(img, gray, cv.COLOR_RGBA2GRAY);
      } else {
        img.copyTo(gray);
      }

      // Count overexposed pixels
      let overexposedCount = 0;
      const totalPixels = gray.rows * gray.cols;
      
      for (let i = 0; i < gray.data.length; i++) {
        if (gray.data[i] >= threshold) {
          overexposedCount++;
        }
      }

      const overexposedRatio = overexposedCount / totalPixels;
      
      gray.delete();

      return {
        overexposedRatio,
        overexposedCount,
        hasGlare: overexposedRatio > this.thresholds.glare.maxOverexposedRatio,
      };
    }

    /**
     * Analyzes document detection quality including size and aspect ratio.
     * @param {Object} cornerPoints - Corner points from jscanify.getCornerPoints()
     * @param {number} frameWidth - Width of the source frame
     * @param {number} frameHeight - Height of the source frame
     * @returns {Object} Document detection quality analysis
     */
    analyzeDocumentDetection(cornerPoints, frameWidth, frameHeight) {
      const { topLeftCorner, topRightCorner, bottomLeftCorner, bottomRightCorner } = cornerPoints;
      
      // Check if all corners are detected
      const allCornersDetected = !!(topLeftCorner && topRightCorner && bottomLeftCorner && bottomRightCorner);
      
      if (!allCornersDetected) {
        return {
          isValid: false,
          allCornersDetected: false,
          reason: 'Not all document corners detected',
        };
      }

      // Calculate document dimensions
      const topWidth = this._distance(topLeftCorner, topRightCorner);
      const bottomWidth = this._distance(bottomLeftCorner, bottomRightCorner);
      const leftHeight = this._distance(topLeftCorner, bottomLeftCorner);
      const rightHeight = this._distance(topRightCorner, bottomRightCorner);

      const avgWidth = (topWidth + bottomWidth) / 2;
      const avgHeight = (leftHeight + rightHeight) / 2;

      // Calculate area ratio
      const documentArea = avgWidth * avgHeight;
      const frameArea = frameWidth * frameHeight;
      const areaRatio = documentArea / frameArea;

      // Calculate aspect ratio (always width/height, assuming landscape orientation)
      const aspectRatio = Math.max(avgWidth, avgHeight) / Math.min(avgWidth, avgHeight);

      // Validate against thresholds
      const { minAreaRatio, maxAreaRatio, minAspectRatio, maxAspectRatio } = this.thresholds.document;
      
      const reasons = [];
      
      if (areaRatio < minAreaRatio) {
        reasons.push('Document too small - move closer');
      }
      if (areaRatio > maxAreaRatio) {
        reasons.push('Document too large - move further');
      }
      if (aspectRatio < minAspectRatio || aspectRatio > maxAspectRatio) {
        reasons.push('Document aspect ratio invalid - ensure full document is visible');
      }

      return {
        isValid: reasons.length === 0,
        allCornersDetected: true,
        areaRatio,
        aspectRatio,
        documentWidth: avgWidth,
        documentHeight: avgHeight,
        reasons,
      };
    }

    /**
     * Performs comprehensive quality assessment on an image with detected document.
     * @param {cv.Mat} img - Input image
     * @param {Object} cornerPoints - Corner points from jscanify.getCornerPoints()
     * @returns {Object} Complete quality assessment result
     */
    assess(img, cornerPoints) {
      const sharpness = this.calculateSharpness(img);
      const glare = this.detectGlare(img);
      const document = this.analyzeDocumentDetection(cornerPoints, img.cols, img.rows);

      const isSharp = sharpness >= this.thresholds.sharpness.min;
      const isSharpGood = sharpness >= this.thresholds.sharpness.good;
      
      const issues = [];
      
      if (!isSharp) {
        issues.push('Image is blurry - hold steady');
      }
      if (glare.hasGlare) {
        issues.push('Glare detected - adjust lighting or angle');
      }
      if (!document.isValid) {
        issues.push(...(document.reasons || []));
      }

      const isAcceptable = isSharp && !glare.hasGlare && document.isValid;
      const isGood = isSharpGood && !glare.hasGlare && document.isValid;

      // Calculate overall score (0-100)
      let score = 0;
      if (document.isValid) score += 40;
      if (!glare.hasGlare) score += 30;
      if (isSharp) score += 20;
      if (isSharpGood) score += 10;

      return {
        isAcceptable,
        isGood,
        score,
        issues,
        details: {
          sharpness: {
            value: sharpness,
            isAcceptable: isSharp,
            isGood: isSharpGood,
          },
          glare: {
            ...glare,
            isAcceptable: !glare.hasGlare,
          },
          document,
        },
      };
    }

    /**
     * Helper: Calculate distance between two points
     */
    _distance(p1, p2) {
      return Math.hypot(p1.x - p2.x, p1.y - p2.y);
    }

    /**
     * Update thresholds dynamically
     * @param {Object} newThresholds - Partial threshold object to merge
     */
    setThresholds(newThresholds) {
      this.thresholds = this._deepMerge(this.thresholds, newThresholds);
    }

    _deepMerge(target, source) {
      const result = { ...target };
      for (const key in source) {
        if (source[key] instanceof Object && key in target) {
          result[key] = this._deepMerge(target[key], source[key]);
        } else {
          result[key] = source[key];
        }
      }
      return result;
    }
  }

  // Export default thresholds for reference
  QualityAssessment.DEFAULT_THRESHOLDS = DEFAULT_THRESHOLDS;

  return QualityAssessment;
});
