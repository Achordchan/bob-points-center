import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { App as AntApp, Modal, Spin } from 'antd';
import { api } from './api.js';
import AppShell from './components/AppShell.jsx';
import DingtalkModal from './components/DingtalkModal.jsx';

const pages = {
  dashboard: lazy(() => import('./pages/Dashboard.jsx')),
  users: lazy(() => import('./pages/Users.jsx')),
  orders: lazy(() => import('./pages/Orders.jsx')),
  commerce: lazy(() => import('./pages/Commerce.jsx')),
  activities: lazy(() => import('./pages/Activities.jsx')),
  messages: lazy(() => import('./pages/Messages.jsx')),
  content: lazy(() => import('./pages/ContentOps.jsx')),
  integrations: lazy(() => import('./pages/Integrations.jsx')),
  audit: lazy(() => import('./pages/AuditSecurity.jsx')),
};

export default function AdminApp() {
  const { message } = AntApp.useApp();
  const [activeKey, setActiveKey] = useState('dashboard');
  const [me, setMe] = useState(null);
  const [dingtalk, setDingtalk] = useState({ connected: false, data: null, error: '' });
  const [modalOpen, setModalOpen] = useState(false);
  const [savingDingtalk, setSavingDingtalk] = useState(false);

  const loadMe = useCallback(async () => {
    const data = await api('/admin/me');
    if (!data?.ok) window.location.replace('/admin/login');
    setMe(data);
  }, []);

  const loadDingtalk = useCallback(async () => {
    try {
      const data = await api('/admin/settings/dingtalk');
      setDingtalk({ connected: data.connected === true, data: data.data || {}, error: data.error || '' });
    } catch (err) {
      setDingtalk((prev) => ({ ...prev, connected: false, error: err.message }));
    }
  }, []);

  useEffect(() => {
    loadMe().catch(() => window.location.replace('/admin/login'));
    loadDingtalk();
  }, [loadMe, loadDingtalk]);

  const saveDingtalk = async (values) => {
    const current = dingtalk.data || {};
    const changed = ['corpId', 'appKey', 'agentId'].some((key) => String(values?.[key] || '') !== String(current?.[key] || '')) || Boolean(values?.appSecret);
    if (changed) {
      const ok = await new Promise((resolve) => {
        Modal.confirm({
          title: '确认修改钉钉连接吗？',
          content: '这会影响通讯录同步、打卡奖励、钉钉消息和部门选择。AppSecret 留空时会沿用当前密钥。',
          okText: '确认修改',
          cancelText: '取消',
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        });
      });
      if (!ok) return;
    }
    setSavingDingtalk(true);
    try {
      await api('/admin/settings/dingtalk', { method: 'POST', body: values });
      await loadDingtalk();
      setModalOpen(false);
      message.success('钉钉连接已保存');
    } catch (err) {
      message.error(err.message || '保存失败');
    } finally {
      setSavingDingtalk(false);
    }
  };

  const logout = async () => {
    await api('/admin/logout', { method: 'POST' }).catch(() => null);
    window.location.replace('/admin/login');
  };

  const Page = pages[activeKey] || pages.dashboard;
  const common = { onOpenDingtalk: () => setModalOpen(true), dingtalk, reloadDingtalk: loadDingtalk, onNavigate: setActiveKey };

  return (
    <>
      <AppShell activeKey={activeKey} onChange={setActiveKey} user={me} dingtalk={dingtalk} onOpenDingtalk={() => setModalOpen(true)} onLogout={logout}>
        <Suspense fallback={<div className="page-loading"><Spin /> 正在加载模块…</div>}>
          <Page {...common} />
        </Suspense>
      </AppShell>
      <DingtalkModal open={modalOpen} state={dingtalk} loading={savingDingtalk} onCancel={() => setModalOpen(false)} onRefresh={loadDingtalk} onSave={saveDingtalk} />
    </>
  );
}
