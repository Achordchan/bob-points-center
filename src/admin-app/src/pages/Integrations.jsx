import { useEffect, useState } from 'react';
import { App, Alert, Button, Card, Descriptions, Form, InputNumber, Modal, Select, Space, Switch, Table, Tabs, Tag, Typography, Upload } from 'antd';
import { api } from '../api.js';
import { formatTs } from '../utils.js';

function Tokens() {
  const { message } = App.useApp(); const [rows, setRows] = useState([]);
  const load = async () => setRows((await api('/bob-token/list?includeRevoked=true&limit=200')).data || []);
  useEffect(() => { load().catch((e) => message.error(e.message)); }, []);
  const create = async () => { const data = await api('/bob-token/create', { method: 'POST' }); message.success('Token 已创建'); if (data.token) navigator.clipboard?.writeText(data.token); load(); };
  return <Card title="BOB Token" extra={<Space><Button onClick={load}>刷新</Button><Button type="primary" onClick={create}>创建 Token</Button></Space>}>
    <Table rowKey="id" dataSource={rows} columns={[{ title: 'ID', dataIndex: 'id' }, { title: 'Token', dataIndex: 'token', ellipsis: true }, { title: '创建时间', dataIndex: 'created_at', render: formatTs }, { title: '吊销时间', dataIndex: 'revoked_at', render: formatTs }, { title: '状态', render: (_, r) => r.revoked_at ? <Tag>已吊销</Tag> : <Tag color="green">有效</Tag> }, { title: '操作', render: (_, r) => <Space><Button disabled={!r.token} onClick={() => navigator.clipboard?.writeText(r.token)}>复制</Button><Button danger disabled={Boolean(r.revoked_at)} onClick={() => api('/bob-token/revoke', { method: 'POST', body: { tokenId: r.id } }).then(load)}>吊销</Button></Space> }]} />
  </Card>;
}

const settingsTables = ['system_settings', 'mall_products', 'charity_projects', 'mall_opening_schedule', 'content_faq', 'content_announcements', 'system_versions'];
const fullTables = ['users', 'accounts', 'bob_tokens', 'ledger', 'redeems', 'redeem_cdks', 'mall_products', 'charity_projects', 'charity_contributions', 'attendance_reward_records', 'mall_opening_schedule', 'red_packet_activity', 'red_packet_items', 'content_faq', 'content_announcements', 'system_versions', 'user_feedback', 'user_feedback_messages', 'audit_logs', 'system_settings'];
function tableRowsFromMap(map = {}) {
  return Object.entries(map).map(([table, count]) => ({ table, count }));
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

function backupFilename(mode) {
  const d = new Date();
  const pad = (v) => String(v).padStart(2, '0');
  return `bob_backup_${mode}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.json`;
}

function Backup() {
  const { message } = App.useApp();
  const [exportDetail, setExportDetail] = useState(null);
  const [importFile, setImportFile] = useState(null);
  const [importMode, setImportMode] = useState('merge');
  const [importDetail, setImportDetail] = useState(null);
  const [importReport, setImportReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState([]);

  const loadHistory = async () => {
    const data = await api('/admin/backup/history?limit=30');
    setHistory(data.data || []);
  };

  useEffect(() => { loadHistory().catch((e) => message.error(e.message || '备份历史加载失败')); }, []);

  const exportBackup = async (mode) => {
    setBusy(true);
    setImportReport(null);
    try {
      const res = await fetch(`/admin/backup/export?mode=${mode}`, { credentials: 'include' });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?._meta) throw new Error(data?.error || '导出失败');
      const filename = data?._meta?.filename || backupFilename(mode);
      downloadJson(filename, data);
      const detail = { mode, filename, meta: data._meta };
      setExportDetail(detail);
      await loadHistory();
      message.success('备份已导出');
    } catch (err) {
      message.error(err.message || '导出失败');
    } finally {
      setBusy(false);
    }
  };

  const parseImportFile = async (file) => {
    setImportFile(file);
    setImportReport(null);
    try {
      const data = JSON.parse(await file.text());
      if (!data?._meta || !data?.data) throw new Error('无效的备份文件');
      setImportDetail({ filename: file.name, meta: data._meta, backup: data });
      message.success('备份文件已读取');
    } catch (err) {
      setImportDetail(null);
      message.error(err.message || '备份文件解析失败');
    }
    return false;
  };

  const doImport = async () => {
    if (!importDetail?.backup) return message.warning('请先选择备份文件');
    const run = async () => {
      setBusy(true);
      try {
        const data = await api('/admin/backup/import', { method: 'POST', body: { backup: importDetail.backup, mode: importMode, filename: importDetail.filename } });
        setImportReport(data.report || {});
        await loadHistory();
        message.success('备份导入完成');
      } catch (err) {
        message.error(err.message || '导入失败');
      } finally {
        setBusy(false);
      }
    };
    if (importMode === 'overwrite') {
      Modal.confirm({
        title: '确认覆盖导入？',
        content: '覆盖模式会清空备份涉及的数据表后重新写入，操作不可撤销。请确认已经保留当前全量备份。',
        okText: '确认覆盖导入',
        okButtonProps: { danger: true },
        cancelText: '取消',
        onOk: run,
      });
      return null;
    }
    return run();
  };

  const exportRows = exportDetail?.meta?.tables ? tableRowsFromMap(exportDetail.meta.tables) : [];
  const importRows = importDetail?.meta?.tables ? tableRowsFromMap(importDetail.meta.tables) : [];
  const reportRows = importReport ? tableRowsFromMap(importReport) : [];

  return <Space direction="vertical" style={{ width: '100%' }} size={12}>
    <Card title="导出备份">
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        <Space wrap>
          <Button loading={busy} onClick={() => exportBackup('settings')}>导出设置备份</Button>
          <Button type="primary" loading={busy} onClick={() => exportBackup('full')}>导出全量备份</Button>
        </Space>
        <Descriptions bordered size="small" column={1} items={[
          { key: 'settings', label: '设置备份', children: settingsTables.join('、') },
          { key: 'full', label: '全量备份', children: fullTables.join('、') },
        ]} />
        {exportDetail && <Table size="small" rowKey="table" pagination={false} dataSource={exportRows} columns={[{ title: '导出表', dataIndex: 'table' }, { title: '记录数', dataIndex: 'count' }]} />}
      </Space>
    </Card>

    <Card title="导入恢复">
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        <Alert type="warning" showIcon message="覆盖导入会替换备份涉及的数据，请先导出当前全量备份。" />
        <Space wrap>
          <Upload accept=".json,application/json" showUploadList={false} beforeUpload={parseImportFile}>
            <Button>选择备份文件</Button>
          </Upload>
          <Select value={importMode} onChange={setImportMode} style={{ width: 260 }} options={[{ value: 'merge', label: '合并导入：保留现有数据' }, { value: 'overwrite', label: '覆盖导入：清空后写入' }]} />
          <Button type="primary" danger={importMode === 'overwrite'} loading={busy} onClick={doImport}>开始导入</Button>
        </Space>
        {importDetail && <Descriptions bordered size="small" column={2} items={[
          { key: 'file', label: '文件', children: importDetail.filename },
          { key: 'mode', label: '备份类型', children: importDetail.meta?.mode === 'full' ? '全量备份' : '设置备份' },
          { key: 'version', label: '备份版本', children: importDetail.meta?.version || '-' },
          { key: 'time', label: '导出时间', children: importDetail.meta?.exportedAt || '-' },
        ]} />}
        {importRows.length > 0 && <Table size="small" rowKey="table" pagination={false} dataSource={importRows} columns={[{ title: '导入文件包含表', dataIndex: 'table' }, { title: '记录数', dataIndex: 'count' }]} />}
        {reportRows.length > 0 && <Table size="small" rowKey="table" pagination={false} dataSource={reportRows} columns={[{ title: '导入结果', dataIndex: 'table' }, { title: '写入记录数', dataIndex: 'count' }]} />}
      </Space>
    </Card>

    <Card title="历史记录">
      <Table size="small" rowKey="id" dataSource={history} pagination={{ pageSize: 8 }} columns={[
        { title: '时间', dataIndex: 'at', render: formatTs },
        { title: '操作', dataIndex: 'action' },
        { title: '类型', dataIndex: 'mode', render: (v) => v === 'full' ? '全量' : v === 'settings' ? '设置' : v === 'overwrite' ? '覆盖导入' : '合并导入' },
        { title: '文件', dataIndex: 'filename', ellipsis: true },
        { title: '状态', dataIndex: 'status' },
      ]} />
      <Typography.Text type="secondary">历史记录保存在服务器，用于追溯最近导出和导入操作。</Typography.Text>
    </Card>
  </Space>;
}


function ImageOptimization() {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await api('/admin/settings/image-optimization');
      setOverview(data.data || {});
      form.setFieldsValue(data.data?.settings || {});
    } catch (err) {
      message.error(err.message || '图片优化状态加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const save = async (values) => {
    setLoading(true);
    try {
      await api('/admin/settings/image-optimization', { method: 'POST', body: values });
      message.success('图片优化配置已保存');
      await load();
    } catch (err) {
      message.error(err.message || '保存失败');
    } finally {
      setLoading(false);
    }
  };

  const runBatch = async (mode) => {
    setRunning(true);
    try {
      const data = await api('/admin/image-optimization/batch', { method: 'POST', body: { mode } });
      const job = data.data || {};
      message.success(`处理完成：成功 ${job.success || 0}，失败 ${job.failed || 0}`);
      await load();
    } catch (err) {
      message.error(err.message || '处理失败');
    } finally {
      setRunning(false);
    }
  };

  const stats = overview?.stats || {};
  const lastJob = overview?.lastJob || null;
  const errorRows = (lastJob?.errors || []).map((error, index) => ({ id: index + 1, error }));

  return <Space direction="vertical" style={{ width: '100%' }} size={12}>
    <Card title="图片优化" extra={<Space wrap><Button loading={loading} onClick={load}>刷新</Button><Button type="primary" loading={running} onClick={() => runBatch('pending')}>转换未优化图片</Button><Button loading={running} onClick={() => runBatch('retry')}>重试</Button></Space>}>
      <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 4 }} items={[
        { key: 'total', label: '图片总数', children: stats.total ?? 0 },
        { key: 'converted', label: '已转 WebP', children: stats.converted ?? 0 },
        { key: 'pending', label: '待处理', children: stats.pending ?? 0 },
        { key: 'external', label: '外链图片', children: stats.external ?? 0 },
      ]} />
    </Card>

    <Card title="处理规则">
      <Form form={form} layout="vertical" onFinish={save} className="settings-form">
        <Form.Item name="enabled" label="启用上传转 WebP" valuePropName="checked"><Switch /></Form.Item>
        <Form.Item name="quality" label="WebP 质量"><InputNumber min={60} max={95} precision={0} /></Form.Item>
        <Form.Item label="最大尺寸"><Space><Form.Item name="maxWidth" noStyle><InputNumber min={320} max={4096} precision={0} addonAfter="宽" /></Form.Item><Form.Item name="maxHeight" noStyle><InputNumber min={320} max={4096} precision={0} addonAfter="高" /></Form.Item></Space></Form.Item>
        <Form.Item name="keepOriginal" label="保留原图" valuePropName="checked"><Switch /></Form.Item>
        <Button type="primary" loading={loading} onClick={() => form.submit()}>保存配置</Button>
      </Form>
    </Card>

    <Card title="最近一次处理">
      {lastJob ? <Space direction="vertical" style={{ width: '100%' }} size={12}>
        <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }} items={[
          { key: 'time', label: '时间', children: formatTs(lastJob.endedAt || lastJob.startedAt) },
          { key: 'total', label: '处理数', children: lastJob.total || 0 },
          { key: 'success', label: '成功', children: lastJob.success || 0 },
          { key: 'failed', label: '失败', children: lastJob.failed || 0 },
          { key: 'skipped', label: '跳过', children: lastJob.skipped || 0 },
          { key: 'mode', label: '模式', children: lastJob.mode === 'retry' ? '重试' : '未优化图片' },
        ]} />
        {errorRows.length > 0 && <Table size="small" rowKey="id" pagination={{ pageSize: 5 }} dataSource={errorRows} columns={[{ title: '失败原因', dataIndex: 'error' }]} />}
      </Space> : <Typography.Text type="secondary">暂无处理记录</Typography.Text>}
    </Card>
  </Space>;
}

export default function Integrations() {
  return <Tabs items={[{ key: 'token', label: 'BOB Token', children: <Tokens /> }, { key: 'backup', label: '备份', children: <Backup /> }, { key: 'images', label: '图片优化', children: <ImageOptimization /> }]} />;
}
