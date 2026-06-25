import { useMemo, useState } from 'react';
import {
  AuditOutlined,
  BellOutlined,
  DashboardOutlined,
  GiftOutlined,
  HomeOutlined,
  LinkOutlined,
  LogoutOutlined,
  MessageOutlined,
  SafetyOutlined,
  SettingOutlined,
  ShoppingOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Button, Dropdown, Layout, Menu, Space, Typography } from 'antd';
import { canAccessNav } from '../permissions.js';

const { Header, Sider, Content } = Layout;

export const navItems = [
  { key: 'dashboard', icon: <DashboardOutlined />, label: '首页概览' },
  { key: 'users', icon: <UserOutlined />, label: '用户与账户' },
  { key: 'orders', icon: <AuditOutlined />, label: '订单与核销' },
  { key: 'commerce', icon: <ShoppingOutlined />, label: '商城与 CDK' },
  { key: 'activities', icon: <GiftOutlined />, label: '活动与公益' },
  { key: 'messages', icon: <MessageOutlined />, label: '消息中心' },
  { key: 'content', icon: <BellOutlined />, label: '内容运营' },
  { key: 'integrations', icon: <LinkOutlined />, label: '系统集成' },
  { key: 'audit', icon: <SafetyOutlined />, label: '审计安全' },
];

export default function AppShell({ activeKey, onChange, user, dingtalk, onOpenDingtalk, onLogout, children }) {
  const [collapsed, setCollapsed] = useState(false);
  const visibleNavItems = useMemo(() => navItems.filter((item) => canAccessNav(user, item.key)), [user]);
  const selected = useMemo(() => navItems.find((item) => item.key === activeKey), [activeKey]);
  const connected = dingtalk?.connected === true;
  const org = dingtalk?.data?.organizationName || dingtalk?.data?.corpId || '未连接';

  return (
    <Layout className="admin-shell">
      <Sider collapsible collapsed={collapsed} onCollapse={setCollapsed} width={232}>
        <div className="brand">
          {!collapsed && <b>BOB币发行管理</b>}
        </div>
        <Menu theme="dark" mode="inline" selectedKeys={[activeKey]} items={visibleNavItems} onClick={({ key }) => onChange(key)} />
      </Sider>
      <Layout>
        <Header className="topbar">
          <Typography.Title level={4} className="page-title">{activeKey === 'myOperations' ? '我的操作记录' : selected?.label || '首页概览'}</Typography.Title>
          <Space wrap>
            <Button className="dingtalk-pill" type={connected ? 'primary' : 'default'} ghost={connected} onClick={onOpenDingtalk}>
              钉钉：{connected ? org : '未连接'}
            </Button>
            <Button href="/docs" target="_blank">API 文档</Button>
            <Dropdown menu={{ items: [{ key: 'my-operations', label: '我的操作记录', onClick: () => onChange('myOperations') }, { type: 'divider' }, { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', onClick: onLogout }] }}>
              <Button icon={<SettingOutlined />}>{user?.name || '管理员'}</Button>
            </Dropdown>
          </Space>
        </Header>
        <Content className="content-wrap">{children}</Content>
      </Layout>
    </Layout>
  );
}
