const scannerState = {
  sessionId: null,
  socket: null,
  connected: false,
  lastBarcode: null,
  videoInput: null,
  codeReader: null,
  mediaStream: null,
  scanning: false,
  shouldReconnect: true,
};

function updateMobileScannerStatus(message, isError = false) {
  const status = document.getElementById('scannerConnectionStatus');
  if (!status) return;
  status.textContent = message;
  status.style.color = isError ? '#dc2626' : '#16a34a';
}

function updateCameraPermissionMessage(message, show = true) {
  const permissionMessage = document.getElementById('cameraPermissionMessage');
  if (!permissionMessage) return;
  permissionMessage.classList.toggle('hidden', !show);
  permissionMessage.querySelector('p').textContent = message;
}

function setScannerActionStates({ scanning = null } = {}) {
  const startButton = document.getElementById('scannerStartButton');
  const restartButton = document.getElementById('scannerRestartButton');
  const disconnectButton = document.getElementById('scannerDisconnectButton');
  if (scanning !== null) {
    scannerState.scanning = scanning;
  }
  if (startButton) startButton.disabled = scannerState.scanning;
  if (restartButton) restartButton.disabled = !scannerState.scanning;
  if (disconnectButton) disconnectButton.disabled = false;
}

function updateScannerSessionUI() {
  document.getElementById('scannerSessionId').textContent = scannerState.sessionId || '--';
  document.getElementById('scannerServerUrl').textContent = `${location.origin}/scanner-socket?role=phone&sessionId=${encodeURIComponent(scannerState.sessionId || '')}`;
  document.getElementById('lastScanValue').textContent = scannerState.lastBarcode || 'None yet';
}

function createScannerWebSocket(sessionId) {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const socketUrl = `${protocol}://${location.host}/scanner-socket?role=phone&sessionId=${encodeURIComponent(sessionId)}`;
  const socket = new WebSocket(socketUrl);

  socket.addEventListener('open', () => {
    scannerState.connected = true;
    updateMobileScannerStatus('Phone scanner connected to POS');
  });

  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      return;
    }

    if (message.type === 'status') {
      updateMobileScannerStatus(message.status === 'connected' ? 'Ready to scan' : message.status, false);
    } else if (message.type === 'pos-status') {
      if (message.status === 'connected') {
        updateMobileScannerStatus('POS paired and ready');
      } else {
        updateMobileScannerStatus('POS disconnected. Reconnect or reopen pairing.', true);
      }
    }
  });

  socket.addEventListener('close', () => {
    scannerState.connected = false;
    if (scannerState.shouldReconnect) {
      updateMobileScannerStatus('Disconnected from POS. Attempting reconnect...', true);
      setTimeout(() => createScannerWebSocket(sessionId), 3000);
    } else {
      updateMobileScannerStatus('Disconnected from POS. Pairing ended.', true);
    }
  });

  socket.addEventListener('error', () => {
    updateMobileScannerStatus('Scanner socket error', true);
  });

  return socket;
}

function sendBarcodeToPos(barcode) {
  if (!scannerState.socket || scannerState.socket.readyState !== WebSocket.OPEN) {
    updateMobileScannerStatus('Not connected to POS', true);
    return;
  }
  scannerState.socket.send(JSON.stringify({ type: 'barcode', barcode }));
  scannerState.lastBarcode = barcode;
  updateScannerSessionUI();
}

function startCameraScan() {
  const video = document.getElementById('videoPreview');
  if (!video) return;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    updateMobileScannerStatus('Camera access not supported in this browser', true);
    updateCameraPermissionMessage('Use a supported browser and allow camera access.', true);
    return;
  }

  const ZXingGlobal = (typeof window !== 'undefined' && (window.ZXingBrowser || window.ZXing)) || (typeof ZXing !== 'undefined' && ZXing);
  const ReaderConstructor = ZXingGlobal && (ZXingGlobal.BrowserMultiFormatContinuousReader || ZXingGlobal.BrowserMultiFormatReader);
  if (!ReaderConstructor) {
    updateMobileScannerStatus('Scanner library failed to load', true);
    updateCameraPermissionMessage('The scanner library is not available. Refresh the page and try again.', true);
    return;
  }

  if (scannerState.scanning) {
    updateMobileScannerStatus('Camera is already running');
    return;
  }

  updateCameraPermissionMessage('Requesting camera access... Please allow the browser to use your camera.', true);
  updateMobileScannerStatus('Requesting camera permission...');

  const codeReader = new ReaderConstructor();
  scannerState.codeReader = codeReader;

  codeReader
    .decodeFromVideoDevice(undefined, video, (result, error) => {
      if (result) {
        const barcode = result.getText();
        if (barcode) {
          scannerState.lastBarcode = barcode;
          sendBarcodeToPos(barcode);
          updateMobileScannerStatus(`Scanned: ${barcode}`);
          updateScannerSessionUI();
        }
      }
      if (error) {
        const notFoundException = ZXingGlobal && ZXingGlobal.NotFoundException;
        if (!(notFoundException && error instanceof notFoundException)) {
          console.warn('Scanner error:', error);
        }
      }
    })
    .then((subscription) => {
      scannerState.decodeSubscription = subscription;
      scannerState.videoInput = null;
      updateMobileScannerStatus('Scanning for barcodes...');
      updateCameraPermissionMessage('', false);
      setScannerActionStates({ scanning: true });
    })
    .catch((error) => {
      const errorDetails = error && error.message ? `${error.name}: ${error.message}` : String(error);
      console.error('Camera start failed:', errorDetails, error);

      if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
        updateMobileScannerStatus('Camera access blocked. Allow use in browser settings.', true);
        updateCameraPermissionMessage('Camera permission denied. Refresh and allow camera access to continue.', true);
      } else if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') {
        updateMobileScannerStatus('No suitable camera found.', true);
        updateCameraPermissionMessage('No compatible camera device is available.', true);
      } else {
        updateMobileScannerStatus(`Unable to start camera: ${errorDetails}`, true);
        updateCameraPermissionMessage('Unable to start the camera. Check console logs for details.', true);
      }
      stopCameraScan();
      setScannerActionStates({ scanning: false });
    });
}

function stopCameraScan() {
  if (scannerState.codeReader) {
    try {
      scannerState.codeReader.reset();
    } catch (error) {
      console.warn('Error resetting code reader:', error);
    }
    scannerState.codeReader = null;
  }

  if (scannerState.decodeSubscription && typeof scannerState.decodeSubscription.stop === 'function') {
    try {
      scannerState.decodeSubscription.stop();
    } catch (error) {
      console.warn('Error stopping video subscription:', error);
    }
    scannerState.decodeSubscription = null;
  }

  if (scannerState.mediaStream) {
    scannerState.mediaStream.getTracks().forEach((track) => track.stop());
    scannerState.mediaStream = null;
  }

  const video = document.getElementById('videoPreview');
  if (video) {
    video.srcObject = null;
  }

  setScannerActionStates({ scanning: false });
}

function initializeScannerPage() {
  const urlParams = new URLSearchParams(window.location.search);
  const sessionId = urlParams.get('sessionId');
  if (!sessionId) {
    updateMobileScannerStatus('No session ID provided', true);
    updateCameraPermissionMessage('Open the scanner from the POS pairing screen to start scanning.', true);
    setScannerActionStates({ scanning: false });
    return;
  }

  scannerState.sessionId = sessionId;
  scannerState.socket = createScannerWebSocket(sessionId);
  updateScannerSessionUI();
  updateMobileScannerStatus('Waiting for camera start');
  updateCameraPermissionMessage('Tap Start Camera to allow camera access and begin scanning.', true);
  setScannerActionStates({ scanning: false });
}

window.addEventListener('DOMContentLoaded', () => {
  const startButton = document.getElementById('scannerStartButton');
  const restartButton = document.getElementById('scannerRestartButton');
  const disconnectButton = document.getElementById('scannerDisconnectButton');

  if (startButton) {
    startButton.addEventListener('click', startCameraScan);
  }

  if (restartButton) {
    restartButton.addEventListener('click', () => {
      stopCameraScan();
      startCameraScan();
    });
  }

  if (disconnectButton) {
    disconnectButton.addEventListener('click', () => {
      scannerState.shouldReconnect = false;
      if (scannerState.socket) {
        scannerState.socket.close();
      }
      stopCameraScan();
      updateMobileScannerStatus('Scanner disconnected');
    });
  }

  initializeScannerPage();
});
