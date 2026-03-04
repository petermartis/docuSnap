/*! docuSnap Document Auto Capture | MIT License */

(function (global, factory) {
  typeof exports === "object" && typeof module !== "undefined"
    ? (module.exports = factory())
    : typeof define === "function" && define.amd
      ? define(factory)
      : (global.DocumentAutoCapture = factory());
})(this, function () {
  "use strict";

  /**
   * Default configuration for document auto-capture
   */
  const DEFAULT_CONFIG = {
    // Video constraints for getUserMedia
    video: {
      facingMode: 'environment', // Use back camera on mobile
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
    // Auto-capture settings
    capture: {
      // Number of consecutive good frames required before auto-capture
      requiredGoodFrames: 5,
      // Minimum interval between quality assessments (ms)
      assessmentInterval: 100,
      // Whether to require "good" quality (stricter) or just "acceptable"
      requireGoodQuality: false,
      // Auto-capture enabled
      enabled: true,
    },
    // Output settings
    output: {
      width: 600,  // Default output width for extracted document
      height: 400, // Default output height for extracted document
    },
    // UI feedback
    feedback: {
      showOverlay: true,
      showInstructions: true,
    },
  };

  /**
   * DocumentAutoCapture - Automatic document capture with quality assessment
   * 
   * Integrates docuSnap for document detection and QualityAssessment for
   * image quality validation to automatically capture documents when
   * quality criteria are met.
   */
  class DocumentAutoCapture {
    /**
     * Create a DocumentAutoCapture instance
     * @param {docuSnap} scanner - docuSnap instance
     * @param {QualityAssessment} qualityAssessment - QualityAssessment instance
     * @param {Object} config - Configuration options
     */
    constructor(scanner, qualityAssessment, config = {}) {
      this.scanner = scanner;
      this.quality = qualityAssessment;
      this.config = this._mergeConfig(DEFAULT_CONFIG, config);
      
      // State
      this.isRunning = false;
      this.stream = null;
      this.videoElement = null;
      this.canvasElement = null;
      this.ctx = null;
      this.consecutiveGoodFrames = 0;
      this.lastAssessmentTime = 0;
      this.animationFrameId = null;
      
      // Callbacks
      this.onCapture = null;
      this.onQualityUpdate = null;
      this.onError = null;
      this.onStateChange = null;
    }

    /**
     * Initialize and start the auto-capture process
     * @param {HTMLVideoElement} videoElement - Video element for camera preview
     * @param {HTMLCanvasElement} canvasElement - Canvas for processing/overlay
     * @returns {Promise<void>}
     */
    async start(videoElement, canvasElement) {
      if (this.isRunning) {
        console.warn('DocumentAutoCapture is already running');
        return;
      }

      this.videoElement = videoElement;
      this.canvasElement = canvasElement;
      this.ctx = canvasElement.getContext('2d');

      try {
        // Check for secure context (required for camera access)
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error(
            'Camera access requires a secure context (HTTPS or localhost). ' +
            'Try accessing via localhost instead of an IP address.'
          );
        }

        // Request camera access
        this.stream = await navigator.mediaDevices.getUserMedia({
          video: this.config.video,
          audio: false,
        });

        this.videoElement.srcObject = this.stream;
        await this.videoElement.play();

        // Set canvas size to match video
        this.canvasElement.width = this.videoElement.videoWidth;
        this.canvasElement.height = this.videoElement.videoHeight;

        this.isRunning = true;
        this.consecutiveGoodFrames = 0;
        
        this._emitStateChange('started');
        
        // Start processing loop
        this._processFrame();
        
      } catch (error) {
        this._emitError('camera_access_denied', error.message);
        throw error;
      }
    }

    /**
     * Stop the auto-capture process and release camera
     */
    stop() {
      this.isRunning = false;
      
      if (this.animationFrameId) {
        cancelAnimationFrame(this.animationFrameId);
        this.animationFrameId = null;
      }

      if (this.stream) {
        this.stream.getTracks().forEach(track => track.stop());
        this.stream = null;
      }

      if (this.videoElement) {
        this.videoElement.srcObject = null;
      }

      this.consecutiveGoodFrames = 0;
      this._emitStateChange('stopped');
    }

    /**
     * Manually trigger capture (bypasses quality check)
     * @returns {Object|null} Capture result or null if no document detected
     */
    captureNow() {
      if (!this.isRunning) {
        console.warn('Cannot capture - auto-capture not running');
        return null;
      }

      return this._performCapture(true);
    }

    /**
     * Main processing loop
     * @private
     */
    _processFrame() {
      if (!this.isRunning) return;

      const now = performance.now();
      
      // Throttle quality assessment
      if (now - this.lastAssessmentTime >= this.config.capture.assessmentInterval) {
        this.lastAssessmentTime = now;
        this._assessFrame();
      }

      this.animationFrameId = requestAnimationFrame(() => this._processFrame());
    }

    /**
     * Assess current video frame quality
     * @private
     */
    _assessFrame() {
      // Draw current frame to canvas
      this.ctx.drawImage(
        this.videoElement,
        0, 0,
        this.canvasElement.width,
        this.canvasElement.height
      );

      // Get image data for OpenCV
      const img = cv.imread(this.canvasElement);
      
      // Find document contour
      const contour = this.scanner.findPaperContour(img);
      
      let assessment = null;
      let cornerPoints = null;

      if (contour) {
        cornerPoints = this.scanner.getCornerPoints(contour);
        assessment = this.quality.assess(img, cornerPoints);
        
        // Draw overlay if enabled
        if (this.config.feedback.showOverlay) {
          this._drawOverlay(cornerPoints, assessment);
        }

        // Check for auto-capture
        if (this.config.capture.enabled) {
          const qualityMet = this.config.capture.requireGoodQuality
            ? assessment.isGood
            : assessment.isAcceptable;

          if (qualityMet) {
            this.consecutiveGoodFrames++;
            
            if (this.consecutiveGoodFrames >= this.config.capture.requiredGoodFrames) {
              this._performCapture(false, img, cornerPoints, assessment);
              this.consecutiveGoodFrames = 0;
            }
          } else {
            this.consecutiveGoodFrames = 0;
          }
        }

        contour.delete();
      } else {
        this.consecutiveGoodFrames = 0;
        assessment = {
          isAcceptable: false,
          isGood: false,
          score: 0,
          issues: ['No document detected'],
          details: null,
        };
      }

      // Emit quality update
      this._emitQualityUpdate(assessment, this.consecutiveGoodFrames);

      img.delete();
    }

    /**
     * Perform document capture
     * @private
     */
    _performCapture(manual = false, existingImg = null, existingCorners = null, existingAssessment = null) {
      let img = existingImg;
      let cornerPoints = existingCorners;
      let assessment = existingAssessment;

      // If called manually without existing data, process current frame
      if (!img) {
        this.ctx.drawImage(
          this.videoElement,
          0, 0,
          this.canvasElement.width,
          this.canvasElement.height
        );
        img = cv.imread(this.canvasElement);
        
        const contour = this.scanner.findPaperContour(img);
        if (!contour) {
          img.delete();
          return null;
        }
        
        cornerPoints = this.scanner.getCornerPoints(contour);
        assessment = this.quality.assess(img, cornerPoints);
        contour.delete();
      }

      // Extract the document
      const extractedCanvas = this.scanner.extractPaper(
        this.canvasElement,
        this.config.output.width,
        this.config.output.height,
        cornerPoints
      );

      // Get original frame as well
      const originalCanvas = document.createElement('canvas');
      originalCanvas.width = this.canvasElement.width;
      originalCanvas.height = this.canvasElement.height;
      originalCanvas.getContext('2d').drawImage(this.canvasElement, 0, 0);

      const result = {
        extracted: extractedCanvas,
        original: originalCanvas,
        cornerPoints,
        assessment,
        manual,
        timestamp: Date.now(),
      };

      // Emit capture event
      if (this.onCapture) {
        this.onCapture(result);
      }

      // Clean up if we created the img
      if (!existingImg && img) {
        img.delete();
      }

      this._emitStateChange('captured');

      return result;
    }

    /**
     * Draw overlay showing document detection and quality status
     * @private
     */
    _drawOverlay(cornerPoints, assessment) {
      const { topLeftCorner, topRightCorner, bottomLeftCorner, bottomRightCorner } = cornerPoints;
      
      if (!topLeftCorner || !topRightCorner || !bottomLeftCorner || !bottomRightCorner) {
        return;
      }

      // Choose color based on quality
      let color;
      if (assessment.isGood) {
        color = '#00ff00'; // Green for good
      } else if (assessment.isAcceptable) {
        color = '#ffff00'; // Yellow for acceptable
      } else {
        color = '#ff0000'; // Red for poor
      }

      // Draw document outline
      this.ctx.strokeStyle = color;
      this.ctx.lineWidth = 3;
      this.ctx.beginPath();
      this.ctx.moveTo(topLeftCorner.x, topLeftCorner.y);
      this.ctx.lineTo(topRightCorner.x, topRightCorner.y);
      this.ctx.lineTo(bottomRightCorner.x, bottomRightCorner.y);
      this.ctx.lineTo(bottomLeftCorner.x, bottomLeftCorner.y);
      this.ctx.closePath();
      this.ctx.stroke();

      // Draw corner markers
      const markerSize = 20;
      this.ctx.fillStyle = color;
      [topLeftCorner, topRightCorner, bottomLeftCorner, bottomRightCorner].forEach(corner => {
        this.ctx.beginPath();
        this.ctx.arc(corner.x, corner.y, markerSize / 2, 0, Math.PI * 2);
        this.ctx.fill();
      });

      // Draw instructions if enabled
      if (this.config.feedback.showInstructions && assessment.issues.length > 0) {
        this.ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        this.ctx.fillRect(10, 10, this.canvasElement.width - 20, 40);
        
        this.ctx.fillStyle = '#ffffff';
        this.ctx.font = '16px sans-serif';
        this.ctx.fillText(assessment.issues[0], 20, 35);
      }

      // Draw quality score
      this.ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
      this.ctx.fillRect(this.canvasElement.width - 80, this.canvasElement.height - 50, 70, 40);
      
      this.ctx.fillStyle = color;
      this.ctx.font = 'bold 24px sans-serif';
      this.ctx.fillText(`${assessment.score}%`, this.canvasElement.width - 70, this.canvasElement.height - 20);
    }

    /**
     * Emit quality update callback
     * @private
     */
    _emitQualityUpdate(assessment, consecutiveGoodFrames) {
      if (this.onQualityUpdate) {
        this.onQualityUpdate({
          assessment,
          consecutiveGoodFrames,
          requiredGoodFrames: this.config.capture.requiredGoodFrames,
          progress: Math.min(consecutiveGoodFrames / this.config.capture.requiredGoodFrames, 1),
        });
      }
    }

    /**
     * Emit error callback
     * @private
     */
    _emitError(code, message) {
      if (this.onError) {
        this.onError({ code, message });
      }
    }

    /**
     * Emit state change callback
     * @private
     */
    _emitStateChange(state) {
      if (this.onStateChange) {
        this.onStateChange(state);
      }
    }

    /**
     * Update configuration
     * @param {Object} newConfig - Partial config to merge
     */
    setConfig(newConfig) {
      this.config = this._mergeConfig(this.config, newConfig);
    }

    /**
     * Deep merge configuration objects
     * @private
     */
    _mergeConfig(target, source) {
      const result = { ...target };
      for (const key in source) {
        if (source[key] instanceof Object && !Array.isArray(source[key]) && key in target) {
          result[key] = this._mergeConfig(target[key], source[key]);
        } else {
          result[key] = source[key];
        }
      }
      return result;
    }
  }

  // Export default config for reference
  DocumentAutoCapture.DEFAULT_CONFIG = DEFAULT_CONFIG;

  return DocumentAutoCapture;
});
