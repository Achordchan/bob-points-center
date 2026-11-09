import { Component, lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Alert, App as AntApp, Button, Modal, Spin } from 'antd';
import { api } from './api.js';
import AppShell from './components/AppShell.jsx';
import DingtalkModal from './components/DingtalkModal.jsx';
import { canAccessNav, hasPermission } from './permissions.js';

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
  myOperations: lazy(() => import('./pages/MyOperations.jsx')),
};

class PageErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidUpdate(prevProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <Alert
      type="error"
      showIcon
      message="模块加载失败"
      description="当前页面资源可能已更新，请重新加载后台后再进入该模块。"
      action={<Button type="primary" onClick={() => window.location.reload()}>重新加载后台</Button>}
    />;
  }
}

// 用户从商城“转发核销”过来的链接：/admin/home?encoded=xxx&encoded=yyy
const MAX_SHARED_REDEEM = 10;

function readSharedRedeemQueue() {
  try {
    const params = new URLSearchParams(window.location.search);
    const list = params.getAll('encoded').map((value) => String(value || '').trim()).filter(Boolean);
    return [...new Set(list)].slice(0, MAX_SHARED_REDEEM);
  } catch {
    return [];
  }
}

export default function AdminApp() {
  const { message, modal } = AntApp.useApp();
  const [sharedRedeemQueue] = useState(readSharedRedeemQueue);
  const [activeKey, setActiveKey] = useState(() => (sharedRedeemQueue.length ? 'orders' : 'dashboard'));
  const [me, setMe] = useState(null);
  const [dingtalk, setDingtalk] = useState({ connected: false, data: null, error: '' });
  const [modalOpen, setModalOpen] = useState(false);
  const [savingDingtalk, setSavingDingtalk] = useState(false);

  const loadMe = useCallback(async () => {
    const data = await api('/admin/me');
    if (!data?.ok) window.location.replace('/admin/login');
    setMe(data);
    return data;
  }, []);

  const loadDingtalk = useCallback(async (currentUser = null) => {
    try {
      const canEditConnection = hasPermission(currentUser, 'integrations:view');
      const data = await api(canEditConnection ? '/admin/settings/dingtalk' : '/admin/settings/dingtalk/status');
      setDingtalk({ connected: data.connected === true, data: data.data || {}, error: data.error || '', readonly: !canEditConnection });
    } catch (err) {
      setDingtalk((prev) => ({ ...prev, connected: false, error: err.message, readonly: true }));
    }
  }, []);

  useEffect(() => {
    loadMe().then((currentUser) => loadDingtalk(currentUser)).catch(() => window.location.replace('/admin/login'));
  }, [loadMe, loadDingtalk]);

  useEffect(() => {
    if (!me || activeKey === 'myOperations' || canAccessNav(me, activeKey)) return;
    const fallback = ['dashboard', 'users', 'orders', 'commerce', 'activities', 'messages', 'content', 'integrations', 'audit'].find((key) => canAccessNav(me, key));
    setActiveKey(fallback || 'myOperations');
  }, [activeKey, me]);

  const canEditDingtalk = hasPermission(me, 'integrations:edit');

  const saveDingtalk = async (values) => {
    const current = dingtalk.data || {};
    const changed = ['corpId', 'appKey', 'agentId'].some((key) => String(values?.[key] || '') !== String(current?.[key] || '')) || Boolean(values?.appSecret);
    if (changed) {
      const ok = await new Promise((resolve) => {
        modal.confirm({
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
      await loadDingtalk(me);
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
  const common = { onOpenDingtalk: () => canEditDingtalk && setModalOpen(true), dingtalk, reloadDingtalk: () => loadDingtalk(me), onNavigate: setActiveKey, me, sharedRedeemQueue };

  return (
    <>
      <AppShell activeKey={activeKey} onChange={setActiveKey} user={me} dingtalk={dingtalk} canEditDingtalk={canEditDingtalk} onOpenDingtalk={() => canEditDingtalk && setModalOpen(true)} onLogout={logout}>
        <PageErrorBoundary resetKey={activeKey}>
          <Suspense fallback={<div className="page-loading"><Spin /> 正在加载模块…</div>}>
            <Page {...common} />
          </Suspense>
        </PageErrorBoundary>
      </AppShell>
      <DingtalkModal open={modalOpen} state={dingtalk} loading={savingDingtalk} onCancel={() => setModalOpen(false)} onRefresh={() => loadDingtalk(me)} onSave={saveDingtalk} />
    </>
  );
}
