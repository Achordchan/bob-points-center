import { useEffect, useState } from 'react';
import { Alert, Button, Card, Col, Row, Space, Statistic, Tag, Timeline, Typography } from 'antd';
import { LinkOutlined, ReloadOutlined } from '@ant-design/icons';
import { ProCard } from '@ant-design/pro-components';
import { api } from '../api.js';
import { amountText } from '../utils.js';

export default function Dashboard({ dingtalk, onOpenDingtalk }) {
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
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type={connected ? 'success' : 'warning'}
        showIcon
        message={connected ? `钉钉已连接：${dingtalk?.data?.organizationName || dingtalk?.data?.corpId || '-'}` : '钉钉未连接'}
        description="钉钉断连只影响通讯录、打卡奖励、钉钉消息和部门选择，不阻断本地管理功能。"
        action={<Button icon={<LinkOutlined />} onClick={onOpenDingtalk}>查看钉钉连接</Button>}
      />
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={6}><Card loading={loading}><Statistic title="用户数" value={summary?.users || 0} suffix="人" /></Card></Col>
        <Col xs={24} sm={12} lg={6}><Card loading={loading}><Statistic title="总余额" value={summary?.balanceTotal || 0} suffix="BOB" /></Card></Col>
        <Col xs={24} sm={12} lg={6}><Card loading={loading}><Statistic title="待核销订单" value={summary?.pendingOrders || 0} /></Card></Col>
        <Col xs={24} sm={12} lg={6}><Card loading={loading}><Statistic title="上架商品" value={summary?.activeProducts || 0} /></Card></Col>
      </Row>
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <ProCard title="运营总览" extra={<Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>} bordered>
            <Row gutter={[16, 16]}>
              <Col span={8}><Statistic title="已核销" value={summary?.fulfilledOrders || 0} /></Col>
              <Col span={8}><Statistic title="未兑换 CDK" value={summary?.unusedCdks || 0} /></Col>
              <Col span={8}><Statistic title="公益助力" value={summary?.charityTotal || 0} suffix="BOB" /></Col>
            </Row>
            <Typography.Paragraph type="secondary" style={{ marginTop: 16 }}>
              商用化后台按账户、订单、商品、活动、消息、内容、集成、安全九个模块管理，危险操作集中收口。
            </Typography.Paragraph>
          </ProCard>
        </Col>
        <Col xs={24} lg={10}>
          <Card title="三套产品设计方向">
            <Timeline
              items={[
                { color: 'blue', children: <><b>企业 SaaS 主线</b><br /><Tag color="blue">当前采用</Tag> 高信息密度、左侧导航、表格与抽屉。</> },
                { color: 'green', children: <><b>运营指挥台</b><br />首页更强调活动与订单看板，适合大屏巡检。</> },
                { color: 'gray', children: <><b>集成控制台</b><br />突出钉钉、消息、备份和审计能力。</> },
              ]}
            />
          </Card>
        </Col>
      </Row>
    </Space>
  );
}
