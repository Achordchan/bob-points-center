import { useEffect, useState } from 'react';
import { App, Button, Card, Descriptions, Empty, Space, Table, Tag, Typography } from 'antd';
import { api } from '../api.js';
import { formatTs, localTablePagination } from '../utils.js';

function formatBytes(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function typeText(type) {
  if (type === 'image') return '图片';
  if (type === 'audio') return '音频';
  if (type === 'video') return '视频';
  return '其他';
}

function riskTag(value) {
  if (value === '低') return <Tag color="green">低风险</Tag>;
  if (value === '中') return <Tag color="orange">中风险</Tag>;
  if (value === '高') return <Tag color="red">高风险</Tag>;
  return <Tag>{value || '-'}</Tag>;
}

export default function ResourceManager({ canEdit }) {
  const { message } = App.useApp();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState([]);

  const load = async () => {
    setLoading(true);
    try {
      const result = await api('/admin/resources/scan');
      setData(result.data || {});
      setSelected([]);
    } catch (err) {
      message.error(err.message || '资源扫描失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const ignoreSelected = async () => {
    if (!selected.length) return message.warning('请先选择要忽略的资源');
    const next = [...new Set([...(data?.ignored || []), ...selected])];
    await api('/admin/resources/ignore', { method: 'POST', body: { paths: next } });
    message.success(`已忽略 ${selected.length} 个资源`);
    await load();
  };

  const summary = data?.summary || {};
  const byType = summary.byType || [];
  const unused = data?.unused || [];

  const columns = [
    { title: '资源路径', dataIndex: 'path', ellipsis: true, render: (value) => <Typography.Text copyable>{value}</Typography.Text> },
    { title: '类型', dataIndex: 'type', width: 90, render: typeText },
    { title: '大小', dataIndex: 'size', width: 110, render: formatBytes, sorter: (a, b) => Number(a.size) - Number(b.size) },
    { title: '风险', dataIndex: 'risk', width: 110, render: riskTag },
    { title: '修改时间', dataIndex: 'modified_at', width: 170, render: formatTs },
    { title: '建议', dataIndex: 'suggestion', width: 170 },
  ];

  return <Space direction="vertical" style={{ width: '100%' }} size={12}>
    <Card title="资源管理" extra={<Space wrap><Button loading={loading} onClick={load}>重新扫描</Button>{canEdit && <Button disabled={!selected.length} onClick={ignoreSelected}>标记忽略</Button>}</Space>}>
      <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 4 }} items={[
        { key: 'total', label: '资源总数', children: summary.total ?? 0 },
        { key: 'size', label: '总占用', children: formatBytes(summary.totalSize) },
        { key: 'unused', label: '疑似未使用', children: unused.length },
        { key: 'unusedSize', label: '可审查空间', children: formatBytes(summary.unusedSize) },
      ]} />
      <div className="resource-type-summary">
        {byType.map((item) => <Tag key={item.type}>{typeText(item.type)}：{item.count} 个 / {formatBytes(item.size)}</Tag>)}
      </div>
      <Typography.Text type="secondary">这里只做审计建议，不会自动删除文件；高风险资源必须人工确认后再处理。</Typography.Text>
    </Card>

    <Card title="疑似未使用资源">
      {unused.length ? <Table
        rowKey="path"
        loading={loading}
        dataSource={unused}
        columns={columns}
        pagination={localTablePagination('个资源', 20)}
        rowSelection={canEdit ? { selectedRowKeys: selected, onChange: (keys) => setSelected(keys.map(String)) } : undefined}
        scroll={{ x: 980 }}
      /> : <Empty description={loading ? '正在扫描资源' : '暂未发现疑似未使用资源'} />}
    </Card>
  </Space>;
}
