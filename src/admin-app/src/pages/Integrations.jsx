import { useEffect, useState } from 'react';
import { App, Alert, Button, Card, Descriptions, Form, Input, InputNumber, Modal, Select, Space, Switch, Table, Tabs, Tag, Typography, Upload } from 'antd';
import { api } from '../api.js';
import { formatTs } from '../utils.js';
import { hasPermission } from '../permissions.js';
import ResourceManager from '../components/ResourceManager.jsx';

function Tokens({ canEdit }) {
  const { message, modal } = App.useApp(); const [rows, setRows] = useState([]);
  const load = async () => setRows((await api('/bob-token/list?includeRevoked=true&limit=200')).data || []);
  useEffect(() => { load().catch((e) => message.error(e.message)); }, []);
  const create = async () => { const data = await api('/bob-token/create', { method: 'POST' }); message.success('Token 已创建'); if (data.token) navigator.clipboard?.writeText(data.token); load(); };
  const remove = (row) => modal.confirm({
    title: '删除已吊销 Token',
    content: `确认删除 Token #${row.id}？删除后不会影响已有账本。`,
    okText: '确认删除',
    cancelText: '取消',
    okButtonProps: { danger: true },
    onOk: async () => { await api('/bob-token/delete', { method: 'POST', body: { tokenId: row.id } }); message.success('Token 已删除'); load(); },
  });
  return <Card title="BOB Token" extra={<Space><Button onClick={load}>刷新</Button>{canEdit && <Button type="primary" onClick={create}>创建 Token</Button>}</Space>}>
    <Table rowKey="id" dataSource={rows} columns={[{ title: 'ID', dataIndex: 'id' }, { title: '创建时间', dataIndex: 'created_at', render: formatTs }, { title: '吊销时间', dataIndex: 'revoked_at', render: formatTs }, { title: '状态', render: (_, r) => r.revoked_at ? <Tag>已吊销</Tag> : <Tag color="green">有效</Tag> }, { title: '操作', render: (_, r) => <Space>{canEdit && <Button danger disabled={Boolean(r.revoked_at)} onClick={() => api('/bob-token/revoke', { method: 'POST', body: { tokenId: r.id } }).then(load)}>吊销</Button>}{canEdit && <Button danger disabled={!r.revoked_at} onClick={() => remove(r)}>删除</Button>}</Space> }]} />
  </Card>;
}

const settingsTables = ['system_settings', 'mall_products', 'charity_projects', 'mall_opening_schedule', 'content_faq', 'content_announcements', 'system_versions', 'admin_roles'];
const fullTables = ['users', 'accounts', 'bob_tokens', 'ledger', 'redeems', 'mall_order_listings', 'redeem_cdks', 'mall_products', 'charity_projects', 'charity_contributions', 'attendance_reward_records', 'mall_opening_schedule', 'red_packet_activity', 'red_packet_items', 'content_faq', 'content_announcements', 'system_versions', 'user_feedback', 'user_feedback_messages', 'audit_logs', 'admin_roles', 'admin_user_roles', 'system_settings'];
function tableRowsFromMap(map = {}) {
  return Object.entries(map).map(([table, count]) => ({ table, count }));
}

function backupTypeText(mode) {
  return mode === 'full' ? '全量备份' : mode === 'settings' ? '设置备份' : mode === 'overwrite' ? '覆盖导入' : '合并导入';
}

function formatBytes(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function parseBackupDetails(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(String(value)); } catch { return null; }
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

async function downloadHistoryBackup(row) {
  const res = await fetch(`/admin/backup/history/${encodeURIComponent(row.id)}/download`, { credentials: 'include' });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || '备份文件下载失败');
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = row.filename || 'bob_backup.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

function backupFilename(mode) {
  const d = new Date();
  const pad = (v) => String(v).padStart(2, '0');
  return `bob_backup_${mode}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.json`;
}

function Backup({ canExport, canImport }) {
  const { message, modal } = App.useApp();
  const [exportDetail, setExportDetail] = useState(null);
  const [exportTablesOpen, setExportTablesOpen] = useState(false);
  const [lastBackup, setLastBackup] = useState(null);
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
      setLastBackup({ filename, data });
      await loadHistory();
      message.success('备份已生成并开始下载');
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
      modal.confirm({
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
  const exportSize = exportDetail?.meta?.size || (lastBackup?.data ? JSON.stringify(lastBackup.data).length : 0);
  const downloadHistory = async (row) => {
    try {
      await downloadHistoryBackup(row);
      message.success('备份文件已开始下载');
    } catch (err) {
      message.error(err.message || '备份文件下载失败');
    }
  };
  const importRows = importDetail?.meta?.tables ? tableRowsFromMap(importDetail.meta.tables) : [];
  const reportRows = importReport ? tableRowsFromMap(importReport) : [];

  return <Space direction="vertical" style={{ width: '100%' }} size={12}>
    <Card title="导出备份">
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        <Space wrap>
          {canExport && <Button loading={busy} onClick={() => exportBackup('settings')}>导出设置备份</Button>}
          {canExport && <Button type="primary" loading={busy} onClick={() => exportBackup('full')}>导出全量备份</Button>}
        </Space>
        <Descriptions bordered size="small" column={1} items={[
          { key: 'settings', label: '设置备份', children: settingsTables.join('、') },
          { key: 'full', label: '全量备份', children: fullTables.join('、') },
        ]} />
        {exportDetail && <Alert
          type="success"
          showIcon
          message="备份文件已生成"
          description={<Space direction="vertical" style={{ width: '100%' }} size={8}>
            <Space wrap>
              <span>文件名：</span><Typography.Text copyable>{exportDetail.filename}</Typography.Text>
              <span>类型：{backupTypeText(exportDetail.mode)}</span>
              <span>大小：{formatBytes(exportSize)}</span>
            </Space>
            <Space wrap>
              {canExport && <Button type="primary" onClick={() => lastBackup && downloadJson(lastBackup.filename, lastBackup.data)}>下载备份文件</Button>}
              <Button onClick={() => setExportTablesOpen(true)}>查看数据表详情</Button>
              <Button onClick={loadHistory}>刷新历史记录</Button>
            </Space>
          </Space>}
        />}
        <Modal
          title="已导出数据表"
          open={exportTablesOpen}
          onCancel={() => setExportTablesOpen(false)}
          footer={<Button type="primary" onClick={() => setExportTablesOpen(false)}>知道了</Button>}
          width={720}
        >
          <Table size="small" rowKey="table" pagination={false} dataSource={exportRows} columns={[{ title: '数据表', dataIndex: 'table' }, { title: '记录数', dataIndex: 'count', width: 140 }]} />
        </Modal>
      </Space>
    </Card>

    {canImport && <Card title="导入恢复">
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
    </Card>}

    <Card title="历史记录">
      <Table size="small" rowKey="id" dataSource={history} pagination={{ pageSize: 8 }} columns={[
        { title: '时间', dataIndex: 'at', render: formatTs, width: 170 },
        { title: '操作', dataIndex: 'action', width: 90 },
        { title: '类型', dataIndex: 'mode', render: backupTypeText, width: 110 },
        { title: '文件', dataIndex: 'filename', ellipsis: true, render: (v) => v ? <Typography.Text copyable>{v}</Typography.Text> : '-' },
        { title: '大小', render: (_, row) => formatBytes(parseBackupDetails(row.details)?.size), width: 110 },
        { title: '状态', dataIndex: 'status', width: 90 },
        { title: '操作', fixed: 'right', width: 180, render: (_, row) => <Space>
          {canExport && row.action === '导出' && <Button size="small" onClick={() => downloadHistory(row)}>下载</Button>}
          {canExport && row.action === '导出' && <Button size="small" onClick={() => exportBackup(row.mode)}>重新导出</Button>}
        </Space> },
      ]} />
      <Typography.Text type="secondary">历史记录保存在服务器；导出记录可直接下载，旧记录文件缺失时请重新导出。</Typography.Text>
    </Card>
  </Space>;
}

function SiteVisibilityControl({ canEdit }) {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [row, setRow] = useState({ enabled: true, message: '' });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const enabled = row?.enabled !== false;

  const load = async () => {
    setLoading(true);
    try {
      const data = await api('/admin/site-visibility');
      const next = data.data || { enabled: true, message: '' };
      setRow(next);
      form.setFieldsValue({
        enabled: next.enabled !== false,
        message: next.message || '',
      });
    } catch (err) {
      message.error(err.message || '前台访问设置加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const save = async (values) => {
    setSaving(true);
    try {
      const data = await api('/admin/site-visibility', {
        method: 'POST',
        body: {
          enabled: values.enabled !== false,
          message: values.message || '',
        },
      });
      setRow(data.data || {});
      form.setFieldsValue({
        enabled: data.data?.enabled !== false,
        message: data.data?.message || '',
      });
      message.success('前台访问设置已保存');
    } catch (err) {
      message.error(err.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return <Card title="前台网站访问控制" loading={loading} extra={<Tag color={enabled ? 'green' : 'red'}>{enabled ? '已开启' : '已关闭'}</Tag>}>
    <Form form={form} layout="vertical" onFinish={save} initialValues={{ enabled: true, message: '' }}>
      <Form.Item name="enabled" label="前台网站是否开启" valuePropName="checked">
        <Switch disabled={!canEdit} checkedChildren="开启" unCheckedChildren="关闭" />
      </Form.Item>
      <Form.Item
        name="message"
        label="关闭时展示给访客的信息"
        extra="关闭后，访客打开前台页面会先看到这段文字，不需要钉钉登录。"
      >
        <Input.TextArea
          disabled={!canEdit}
          rows={3}
          maxLength={500}
          showCount
          placeholder="例如：系统维护中，请稍后再试。"
        />
      </Form.Item>
      <Space>
        <Button onClick={load} loading={loading}>刷新</Button>
        {canEdit && <Button type="primary" htmlType="submit" loading={saving}>保存设置</Button>}
      </Space>
    </Form>
  </Card>;
}

function ImageOptimization({ canEdit }) {
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
    <Card title="图片优化" extra={<Space wrap><Button loading={loading} onClick={load}>刷新</Button>{canEdit && <Button type="primary" loading={running} onClick={() => runBatch('pending')}>转换未优化图片</Button>}{canEdit && <Button loading={running} onClick={() => runBatch('retry')}>重试</Button>}</Space>}>
      <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 4 }} items={[
        { key: 'total', label: '图片总数', children: stats.total ?? 0 },
        { key: 'converted', label: '已转 WebP', children: stats.converted ?? 0 },
        { key: 'pending', label: '待处理', children: stats.pending ?? 0 },
        { key: 'external', label: '外链图片', children: stats.external ?? 0 },
      ]} />
    </Card>

    <Card title="处理规则">
      <Form form={form} layout="vertical" onFinish={save} className="image-optimization-settings-form">
        <div className="image-optimization-settings-grid">
          <Form.Item name="enabled" label="上传自动转 WebP" valuePropName="checked"><Switch disabled={!canEdit} /></Form.Item>
          <Form.Item name="quality" label="WebP 质量"><InputNumber min={60} max={95} precision={0} disabled={!canEdit} style={{ width: '100%' }} /></Form.Item>
          <Form.Item label="最大尺寸" className="image-optimization-size-field">
            <Space.Compact style={{ width: '100%' }}>
              <Form.Item name="maxWidth" noStyle><InputNumber min={320} max={4096} precision={0} addonAfter="宽" disabled={!canEdit} style={{ width: '50%' }} /></Form.Item>
              <Form.Item name="maxHeight" noStyle><InputNumber min={320} max={4096} precision={0} addonAfter="高" disabled={!canEdit} style={{ width: '50%' }} /></Form.Item>
            </Space.Compact>
          </Form.Item>
          <Form.Item name="keepOriginal" label="保留原图" valuePropName="checked"><Switch disabled={!canEdit} /></Form.Item>
        </div>
        {canEdit && <div className="image-optimization-settings-actions"><Button type="primary" loading={loading} onClick={() => form.submit()}>保存配置</Button></div>}
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

export default function Integrations({ me }) {
  const canEdit = hasPermission(me, 'integrations:edit');
  const canExport = hasPermission(me, 'integrations:export');
  const canImport = me?.isSuperAdmin === true;
  return <Tabs items={[
    { key: 'settings', label: '系统设置', children: <SiteVisibilityControl canEdit={canEdit} /> },
    { key: 'token', label: 'BOB Token', children: <Tokens canEdit={canEdit} /> },
    { key: 'backup', label: '备份', children: <Backup canExport={canExport} canImport={canImport} /> },
    { key: 'images', label: '图片优化', children: <ImageOptimization canEdit={canEdit} /> },
    { key: 'resources', label: '资源管理', children: <ResourceManager canEdit={canEdit} /> },
  ]} />;
}
