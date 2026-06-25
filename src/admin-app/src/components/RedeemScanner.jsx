import { useCallback, useEffect, useRef, useState } from 'react';
import { CameraOutlined, CheckOutlined, CopyOutlined, StopOutlined, UploadOutlined } from '@ant-design/icons';
import { App, Button, Card, Input, Space, Typography, Upload } from 'antd';
import { api, translateErrorMessage } from '../api.js';

const DINGTALK_JSAPI_SRC = 'https://g.alicdn.com/dingding/dingtalk-jsapi/2.15.4/dingtalk.open.js';
let dingtalkScriptPromise = null;
let barcodeDetector = null;

function normalizeEncoded(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    return url.searchParams.get('encoded') || url.searchParams.get('code') || text;
  } catch {
    return text;
  }
}

function loadDingtalkJsapi() {
  if (window.dd) return Promise.resolve(true);
  if (dingtalkScriptPromise) return dingtalkScriptPromise;
  dingtalkScriptPromise = new Promise((resolve) => {
    const existing = document.querySelector(`script[src="${DINGTALK_JSAPI_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(Boolean(window.dd)), { once: true });
      existing.addEventListener('error', () => resolve(false), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = DINGTALK_JSAPI_SRC;
    script.async = true;
    script.onload = () => resolve(Boolean(window.dd));
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });
  return dingtalkScriptPromise;
}

function isDingtalkClient() {
  return /DingTalk/i.test(navigator.userAgent || '');
}

function formatBrowserPermissionError(error, actionText) {
  const raw = String(error?.name || error?.message || error || '').trim();
  const lower = raw.toLowerCase();
  if (lower.includes('notallowederror') || lower.includes('permission denied') || lower.includes('permission dismissed')) {
    return `${actionText}权限未开启，请在浏览器地址栏允许后重试。`;
  }
  if (lower.includes('notfounderror') || lower.includes('no camera') || lower.includes('not found')) {
    return '没有检测到可用摄像头，请上传二维码图片或粘贴 encoded 内容。';
  }
  if (lower.includes('notreadableerror') || lower.includes('could not start')) {
    return '摄像头被其他应用占用，请关闭占用程序后重试。';
  }
  return translateErrorMessage(error?.message || error) || '操作失败';
}

async function tryDingtalkScan() {
  if (!isDingtalkClient()) return '';
  const loaded = await loadDingtalkJsapi();
  const dd = window.dd;
  if (!loaded || !dd?.biz?.util?.scan) return '';

  let cfg = null;
  try {
    const url = window.location.href.split('#')[0];
    cfg = await api(`/admin/config?url=${encodeURIComponent(url)}`);
  } catch {
    return '';
  }
  if (cfg?.error) return '';

  const ready = await new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(false), 2500);
    try {
      dd.config({
        agentId: cfg.agentId,
        corpId: cfg.corpId,
        timeStamp: cfg.timeStamp,
        nonceStr: cfg.nonceStr,
        signature: cfg.signature,
        jsApiList: ['biz.util.scan'],
      });
      dd.ready(() => {
        window.clearTimeout(timer);
        resolve(true);
      });
      dd.error(() => {
        window.clearTimeout(timer);
        resolve(false);
      });
    } catch {
      window.clearTimeout(timer);
      resolve(false);
    }
  });
  if (!ready) return '';

  return new Promise((resolve) => {
    dd.biz.util.scan({
      type: 'qrCode',
      onSuccess: (data) => resolve(normalizeEncoded(data?.text || data?.resultStr || '')),
      onFail: () => resolve(''),
    });
  });
}

async function createDetector() {
  if (typeof window.BarcodeDetector !== 'function') return null;
  if (!barcodeDetector) barcodeDetector = new window.BarcodeDetector({ formats: ['qr_code'] });
  return barcodeDetector;
}

async function detectFromImageSource(source) {
  const detector = await createDetector();
  if (!detector) throw new Error('当前浏览器不支持二维码识别，请粘贴 encoded 内容核销。');
  const codes = await detector.detect(source);
  const raw = codes?.[0]?.rawValue || '';
  if (!raw) throw new Error('未识别到二维码');
  return normalizeEncoded(raw);
}

async function detectFromFile(file) {
  if (typeof window.createImageBitmap === 'function') {
    const bitmap = await window.createImageBitmap(file);
    try {
      return await detectFromImageSource(bitmap);
    } finally {
      bitmap.close?.();
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片读取失败'));
      img.src = url;
    });
    return await detectFromImageSource(image);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function RedeemScanner({ encoded, onEncodedChange, onRedeem, redeeming }) {
  const { message } = App.useApp();
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const scanActiveRef = useRef(false);
  const frameRef = useRef(0);
  const [scanning, setScanning] = useState(false);
  const [detecting, setDetecting] = useState(false);

  const stopCamera = useCallback(() => {
    scanActiveRef.current = false;
    if (frameRef.current) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    setScanning(false);
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  const applyDetected = useCallback((value, successText = '已识别二维码，请确认核销') => {
    const next = normalizeEncoded(value);
    if (!next) return false;
    onEncodedChange(next);
    message.success(successText);
    return true;
  }, [message, onEncodedChange]);

  const scanVideoFrame = useCallback(async () => {
    const video = videoRef.current;
    if (!scanActiveRef.current || !video) return;
    if (video.videoWidth && video.videoHeight) {
      try {
        const value = await detectFromImageSource(video);
        if (applyDetected(value)) {
          stopCamera();
          return;
        }
      } catch (err) {
        if (String(err?.message || '').includes('不支持二维码识别')) {
          message.warning(err.message);
          stopCamera();
          return;
        }
      }
    }
    frameRef.current = window.requestAnimationFrame(scanVideoFrame);
  }, [applyDetected, message, stopCamera]);

  const startCameraScan = async () => {
    setDetecting(true);
    try {
      const nativeValue = await tryDingtalkScan();
      if (nativeValue) {
        applyDetected(nativeValue, '已通过钉钉扫码识别');
        return;
      }

      if (!navigator.mediaDevices?.getUserMedia) {
        message.warning('当前浏览器不支持摄像头，请上传图片或粘贴 encoded 内容。');
        return;
      }
      if (!(await createDetector())) {
        message.warning('当前浏览器不支持二维码识别，请上传支持识别的浏览器处理，或粘贴 encoded 内容。');
        return;
      }
      stopCamera();
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      streamRef.current = stream;
      scanActiveRef.current = true;
      setScanning(true);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      frameRef.current = window.requestAnimationFrame(scanVideoFrame);
    } catch (err) {
      message.error(formatBrowserPermissionError(err, '摄像头'));
      stopCamera();
    } finally {
      setDetecting(false);
    }
  };

  const handleFile = async (file) => {
    setDetecting(true);
    try {
      applyDetected(await detectFromFile(file));
    } catch (err) {
      message.warning(err.message || '二维码识别失败');
    } finally {
      setDetecting(false);
    }
    return false;
  };

  const readClipboard = async () => {
    if (!navigator.clipboard?.read) {
      message.warning('当前浏览器不支持读取剪贴板，请点击粘贴区域后使用 Ctrl/⌘+V。');
      return;
    }
    setDetecting(true);
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const imageType = item.types.find((type) => type.startsWith('image/'));
        if (imageType) {
          applyDetected(await detectFromFile(await item.getType(imageType)));
          return;
        }
        if (item.types.includes('text/plain')) {
          const text = await (await item.getType('text/plain')).text();
          if (applyDetected(text, '已读取剪贴板内容')) return;
        }
      }
      message.warning('剪贴板中没有二维码图片或 encoded 内容');
    } catch (err) {
      message.warning(formatBrowserPermissionError(err, '剪贴板'));
    } finally {
      setDetecting(false);
    }
  };

  const handlePaste = async (event) => {
    const text = event.clipboardData?.getData('text/plain');
    if (text && applyDetected(text, '已粘贴 encoded 内容')) return;
    const imageItem = Array.from(event.clipboardData?.items || []).find((item) => item.type.startsWith('image/'));
    const file = imageItem?.getAsFile();
    if (!file) return;
    setDetecting(true);
    try {
      applyDetected(await detectFromFile(file));
    } catch (err) {
      message.warning(err.message || '二维码识别失败');
    } finally {
      setDetecting(false);
    }
  };

  const confirmRedeem = async () => {
    const ok = await onRedeem();
    if (ok) stopCamera();
  };

  return <Card className="redeem-scanner-card" size="small" title="扫码核销">
    <Space className="redeem-scanner-actions" wrap>
      <Button type={encoded.trim() ? 'default' : 'primary'} size="large" icon={<CameraOutlined />} loading={detecting} onClick={startCameraScan}>打开摄像头扫码</Button>
      <Button type="primary" size="large" icon={<CheckOutlined />} loading={redeeming} disabled={!encoded.trim()} onClick={confirmRedeem}>确认核销</Button>
      {scanning && <Button icon={<StopOutlined />} onClick={stopCamera}>停止扫码</Button>}
      <Upload accept="image/*" showUploadList={false} beforeUpload={handleFile}>
        <Button icon={<UploadOutlined />} loading={detecting}>上传二维码图片</Button>
      </Upload>
      <Button icon={<CopyOutlined />} onClick={readClipboard}>读取剪贴板</Button>
    </Space>
    <div className="redeem-scanner-grid">
      <div className={`redeem-scanner-camera${scanning ? ' is-scanning' : ''}`}>
        <video ref={videoRef} className={scanning ? 'redeem-scanner-video' : 'redeem-scanner-video is-hidden'} muted playsInline />
        {!scanning && <div className="redeem-scanner-placeholder">
          <Typography.Text strong>手机端优先扫码</Typography.Text>
          <Typography.Text type="secondary">电脑端可上传或粘贴二维码图片。</Typography.Text>
        </div>}
      </div>
      <div className="redeem-scanner-panel">
        <div className="redeem-scanner-paste" tabIndex={0} onPaste={handlePaste}>点击后粘贴二维码图片或 encoded 文本</div>
        <Input.TextArea value={encoded} onChange={(event) => onEncodedChange(event.target.value)} placeholder="二维码 encoded 内容" rows={3} />
      </div>
    </div>
  </Card>;
}
