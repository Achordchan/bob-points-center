import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Col, Progress, Row, Space, Statistic, Tag, Typography } from 'antd';
import { AuditOutlined, GiftOutlined, LinkOutlined, ReloadOutlined, SafetyOutlined, ShoppingOutlined, UserOutlined } from '@ant-design/icons';
import { ProCard } from '@ant-design/pro-components';
import { api } from '../api.js';

function metricValue(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

export default function Dashboard({ dingtalk, onOpenDingtalk, onNavigate }) {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      setSummary((await api('/admin/dashboard/summary')).data || {});
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
  const healthItems = useMemo(() => [
    { key: 'ding', label: '钉钉基础连接', ok: connected, action: '查看连接', onClick: onOpenDingtalk },
    { key: 'order', label: '待核销订单', ok: pendingOrders === 0, value: `${pendingOrders} 单`, action: '处理订单', onClick: () => onNavigate?.('orders') },
    { key: 'cdk', label: '未兑换 CDK', ok: unusedCdks > 0, value: `${unusedCdks} 个`, action: '查看 CDK', onClick: () => onNavigate?.('commerce') },
    { key: 'product', label: '上架商品', ok: activeProducts > 0, value: `${activeProducts} 个`, action: '管理商品', onClick: () => onNavigate?.('commerce') },
  ], [activeProducts, connected, onNavigate, onOpenDingtalk, pendingOrders, unusedCdks]);

  const completion = Math.round(((connected ? 1 : 0) + (activeProducts > 0 ? 1 : 0) + (fulfilledOrders > 0 ? 1 : 0) + (metricValue(summary?.users) > 0 ? 1 : 0)) / 4 * 100);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type={connected ? 'success' : 'warning'}
        showIcon
        message={connected ? `钉钉已连接：${dingtalk?.data?.organizationName || dingtalk?.data?.corpId || '-'}` : '钉钉未连接'}
        description="钉钉断连只影响通讯录、打卡奖励、钉钉消息和部门选择，不阻断用户、商城、订单等本地管理能力。"
        action={<Button icon={<LinkOutlined />} onClick={onOpenDingtalk}>查看钉钉连接</Button>}
      />

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={6}><Card loading={loading}><Statistic title="用户数" value={metricValue(summary?.users)} suffix="人" prefix={<UserOutlined />} /></Card></Col>
        <Col xs={24} sm={12} lg={6}><Card loading={loading}><Statistic title="总余额" value={metricValue(summary?.balanceTotal)} suffix="BOB" /></Card></Col>
        <Col xs={24} sm={12} lg={6}><Card loading={loading}><Statistic title="待核销订单" value={pendingOrders} prefix={<AuditOutlined />} /></Card></Col>
        <Col xs={24} sm={12} lg={6}><Card loading={loading}><Statistic title="上架商品" value={activeProducts} prefix={<ShoppingOutlined />} /></Card></Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <ProCard title="运营概览" extra={<Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>} bordered>
            <Row gutter={[16, 16]}>
              <Col xs={24} sm={8}><Statistic title="已核销订单" value={fulfilledOrders} /></Col>
              <Col xs={24} sm={8}><Statistic title="未兑换 CDK" value={unusedCdks} /></Col>
              <Col xs={24} sm={8}><Statistic title="公益助力" value={metricValue(summary?.charityTotal)} suffix="BOB" prefix={<GiftOutlined />} /></Col>
            </Row>
            <div className="dashboard-progress">
              <Space direction="vertical" style={{ width: '100%' }}>
                <Typography.Text strong>运营数据完整度</Typography.Text>
                <Progress percent={completion} status={completion >= 75 ? 'success' : 'active'} />
                <Typography.Text type="secondary">按钉钉连接、商品、订单、用户四个基础项计算，用于快速判断后台是否具备日常运营条件。</Typography.Text>
              </Space>
            </div>
          </ProCard>
        </Col>

        <Col xs={24} lg={10}>
          <Card title="待办与健康检查" extra={<Tag color={connected ? 'success' : 'warning'}>{connected ? '基础正常' : '需要处理'}</Tag>}>
            <Space direction="vertical" style={{ width: '100%' }}>
              {healthItems.map((item) => (
                <div className="health-row" key={item.key}>
                  <div>
                    <Typography.Text strong>{item.label}</Typography.Text>
                    <div><Typography.Text type="secondary">{item.value || (item.ok ? '正常' : '待处理')}</Typography.Text></div>
                  </div>
                  <Space>
                    <Tag color={item.ok ? 'success' : 'warning'}>{item.ok ? '正常' : '待处理'}</Tag>
                    <Button size="small" onClick={item.onClick}>{item.action}</Button>
                  </Space>
                </div>
              ))}
            </Space>
          </Card>
        </Col>
      </Row>

      <Card title="快捷入口">
        <Space wrap>
          <Button icon={<UserOutlined />} onClick={() => onNavigate?.('users')}>用户与账户</Button>
          <Button icon={<AuditOutlined />} onClick={() => onNavigate?.('orders')}>订单与核销</Button>
          <Button icon={<ShoppingOutlined />} onClick={() => onNavigate?.('commerce')}>商城与 CDK</Button>
          <Button icon={<GiftOutlined />} onClick={() => onNavigate?.('activities')}>活动与公益</Button>
          <Button icon={<SafetyOutlined />} onClick={() => onNavigate?.('audit')}>审计安全</Button>
        </Space>
      </Card>
    </Space>
  );
}
