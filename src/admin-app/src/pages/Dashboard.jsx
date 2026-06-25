import { useEffect, useState } from 'react';
import { Alert, Button, Card, Col, Row, Space, Statistic, Typography } from 'antd';
import { AuditOutlined, GiftOutlined, LinkOutlined, ReloadOutlined, SafetyOutlined, ShoppingOutlined, UserOutlined } from '@ant-design/icons';
import { ProCard } from '@ant-design/pro-components';
import { api } from '../api.js';

function metricValue(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}


function formatUptime(seconds) {
  const total = Number(seconds || 0);
  if (!Number.isFinite(total) || total <= 0) return '-';
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return `${days} 天 ${hours} 小时 ${minutes} 分钟`;
}

function formatMemory(info) {
  const total = Number(info?.memoryTotalMb || 0);
  const free = Number(info?.memoryFreeMb || 0);
  if (!total) return '-';
  return `${Math.round((total - free) / 1024)} / ${Math.round(total / 1024)} GB`;
}

export default function Dashboard({ dingtalk, onOpenDingtalk, onNavigate }) {
  const [summary, setSummary] = useState(null);
  const [systemInfo, setSystemInfo] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [summaryData, infoData] = await Promise.all([
        api('/admin/dashboard/summary'),
        api('/admin/system/info').catch(() => ({ data: null })),
      ]);
      setSummary(summaryData.data || {});
      setSystemInfo(infoData.data || null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load().catch(() => null); }, []);

  const connected = dingtalk?.connected === true;
  const pendingOrders = metricValue(summary?.pendingOrders);
  const unusedCdks = metricValue(summary?.unusedCdks);
  const activeProducts = metricValue(summary?.activeProducts);
  const fulfilledOrders = metricValue(summary?.fulfilledOrders);
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {!connected && (
        <Alert
          type="warning"
          showIcon
          message="钉钉未连接"
          action={<Button icon={<LinkOutlined />} onClick={onOpenDingtalk}>查看连接</Button>}
        />
      )}

      <Card title="快捷入口">
        <Space wrap>
          <Button icon={<UserOutlined />} onClick={() => onNavigate?.('users')}>用户与账户</Button>
          <Button icon={<AuditOutlined />} onClick={() => onNavigate?.('orders')}>订单与核销</Button>
          <Button icon={<ShoppingOutlined />} onClick={() => onNavigate?.('commerce')}>商城与 CDK</Button>
          <Button icon={<GiftOutlined />} onClick={() => onNavigate?.('activities')}>活动与公益</Button>
          <Button icon={<SafetyOutlined />} onClick={() => onNavigate?.('audit')}>审计安全</Button>
        </Space>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={6}><Card loading={loading}><Statistic title="用户数" value={metricValue(summary?.users)} suffix="人" prefix={<UserOutlined />} /></Card></Col>
        <Col xs={24} sm={12} lg={6}><Card loading={loading}><Statistic title="总余额" value={metricValue(summary?.balanceTotal)} suffix="BOB" /></Card></Col>
        <Col xs={24} sm={12} lg={6}><Card loading={loading} hoverable className="dashboard-link-card" onClick={() => onNavigate?.('orders')}><Statistic title={<Typography.Link>待核销订单</Typography.Link>} value={pendingOrders} prefix={<AuditOutlined />} /></Card></Col>
        <Col xs={24} sm={12} lg={6}><Card loading={loading} hoverable className="dashboard-link-card" onClick={() => onNavigate?.('commerce')}><Statistic title={<Typography.Link>上架商品</Typography.Link>} value={activeProducts} prefix={<ShoppingOutlined />} /></Card></Col>
      </Row>

      <ProCard className="dashboard-equal-card" title="运营概览" extra={<Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>} bordered>
        <Row gutter={[16, 16]}>
          <Col xs={24} sm={8}><Statistic title="已核销订单" value={fulfilledOrders} /></Col>
          <Col xs={24} sm={8}><Statistic title="未兑换 CDK" value={unusedCdks} /></Col>
          <Col xs={24} sm={8}><Statistic title="公益助力" value={metricValue(summary?.charityTotal)} suffix="BOB" prefix={<GiftOutlined />} /></Col>
        </Row>
      </ProCard>

      <Card title="系统信息">
        <div className="system-info-grid">
          <div><Typography.Text type="secondary">服务名称</Typography.Text><b>{systemInfo?.service || '-'}</b></div>
          <div><Typography.Text type="secondary">访问域名</Typography.Text><b>{systemInfo?.host || '-'}</b></div>
          <div><Typography.Text type="secondary">公网 IP</Typography.Text><b>{systemInfo?.ip || '-'}</b></div>
          <div><Typography.Text type="secondary">内网 IP</Typography.Text><b>{systemInfo?.localIps?.join('、') || '-'}</b></div>
          <div><Typography.Text type="secondary">主机名</Typography.Text><b>{systemInfo?.hostname || '-'}</b></div>
          <div><Typography.Text type="secondary">系统</Typography.Text><b>{systemInfo?.platform || '-'}</b></div>
          <div><Typography.Text type="secondary">架构</Typography.Text><b>{systemInfo?.arch || '-'}</b></div>
          <div><Typography.Text type="secondary">CPU</Typography.Text><b>{systemInfo?.cpu ? `${systemInfo.cpu} × ${systemInfo.cpuCores || 1}` : '-'}</b></div>
          <div><Typography.Text type="secondary">内存占用</Typography.Text><b>{formatMemory(systemInfo)}</b></div>
          <div><Typography.Text type="secondary">运行环境</Typography.Text><b>{systemInfo?.environment || '-'}</b></div>
          <div><Typography.Text type="secondary">后端</Typography.Text><b>{systemInfo?.runtime || '-'}</b></div>
          <div><Typography.Text type="secondary">前端</Typography.Text><b>{systemInfo?.frontend || '-'}</b></div>
          <div><Typography.Text type="secondary">数据库</Typography.Text><b>{systemInfo?.database || '-'}</b></div>
          <div><Typography.Text type="secondary">版本号</Typography.Text><b>{systemInfo?.version || '-'}</b></div>
          <div><Typography.Text type="secondary">进程 ID</Typography.Text><b>{systemInfo?.pid || '-'}</b></div>
          <div><Typography.Text type="secondary">运行时长</Typography.Text><b>{formatUptime(systemInfo?.uptimeSeconds)}</b></div>
          <div><Typography.Text type="secondary">时区</Typography.Text><b>{systemInfo?.timezone || '-'}</b></div>
          <div><Typography.Text type="secondary">作者</Typography.Text><b>{systemInfo?.author || '-'}</b></div>
          <div><Typography.Text type="secondary">邮箱</Typography.Text><b>{systemInfo?.authorEmail || '-'}</b></div>
          <div><Typography.Text type="secondary">手机号</Typography.Text><b>{systemInfo?.authorPhone || '-'}</b></div>
          <div><Typography.Text type="secondary">地区</Typography.Text><b>{systemInfo?.authorRegion || '-'}</b></div>
        </div>
      </Card>

    </Space>
  );
}
