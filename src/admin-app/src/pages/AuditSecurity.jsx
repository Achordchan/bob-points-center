import { useEffect, useState } from 'react';
import { App, Button, Card, Input, Modal, Space, Table, Tag, Typography } from 'antd';
import { api, qs } from '../api.js';
import { formatTs } from '../utils.js';

export default function AuditSecurity() {
  const { message } = App.useApp();
  const [rows, setRows] = useState([]);
  const [days, setDays] = useState(30);
  const load = async () => setRows((await api(`/admin/logs?${qs({ days, limit: 300 })}`)).data || []);
  useEffect(() => { load().catch((e) => message.error(e.message)); }, []);
  const resetAll = () => Modal.confirm({
    title: '危险区：清空全部用户业务数据',
    content: '将删除所有积分流水和兑换订单，并把余额重置为 0。请输入 RESET_ALL 后才允许继续。',
    okButtonProps: { danger: true }, okText: '确认执行', cancelText: '取消',
    onOk: async () => {
      const confirm = window.prompt('请输入确认口令：RESET_ALL');
      if (confirm !== 'RESET_ALL') return message.warning('口令不正确，已取消');
      await api('/admin/data/reset-all', { method: 'POST', body: { confirm: 'RESET_ALL' } });
      message.success('已清空全部业务数据');
    },
  });
  return <Space direction="vertical" style={{ width: '100%' }}>
    <Card title="审计日志" extra={<Space><Input value={days} onChange={(e) => setDays(e.target.value)} suffix="天" style={{ width: 120 }} /><Button onClick={load}>刷新</Button></Space>}>
      <Table rowKey="id" dataSource={rows} scroll={{ x: 1180 }} columns={[{ title: '时间', dataIndex: 'created_at', render: formatTs }, { title: '事件', dataIndex: 'event_type', render: (v) => <Tag>{v}</Tag> }, { title: '操作者', render: (_, r) => r.actor_name || r.actor_id || r.actor_type }, { title: '路径', dataIndex: 'path', ellipsis: true }, { title: '状态', dataIndex: 'status_code' }, { title: '说明', dataIndex: 'message', ellipsis: true }]} />
    </Card>
    <Card title="危险区" className="danger-card">
      <Button danger onClick={resetAll}>清空全部用户业务数据</Button>
    </Card>
  </Space>;
}
