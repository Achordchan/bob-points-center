import { useEffect, useState } from 'react';
import { App, Alert, Button, Card, Descriptions, Form, Input, InputNumber, Modal, Select, Space, Switch, Table, Tabs, Tag, Typography, Upload } from 'antd';
import { api } from '../api.js';
import { formatTs } from '../utils.js';

function Attendance({ dingtalk }) {
  const { message } = App.useApp(); const [form] = Form.useForm(); const [departments, setDepartments] = useState([]); const [mode, setMode] = useState('all');
  const load = async () => { const data = await api('/admin/settings/attendance-reward'); form.setFieldsValue(data.data || {}); setMode(data.data?.departmentMode || 'all'); };
  const loadDepartments = async () => { if (!dingtalk?.connected) return setDepartments([]); setDepartments((await api('/admin/settings/dingtalk/departments')).data || []); };
  useEffect(() => { load().catch((e) => message.error(e.message)); }, []);
  useEffect(() => { loadDepartments().catch(() => setDepartments([])); }, [dingtalk?.connected]);
  const save = async (values) => { await api('/admin/settings/attendance-reward', { method: 'POST', body: { ...values, departmentMode: mode, departmentIds: mode === 'selected' ? values.departmentIds || [] : [] } }); message.success('打卡奖励已保存'); load(); };
  return <Card title="钉钉打卡奖励" extra={<Button type="primary" onClick={() => form.submit()}>保存</Button>}>
    {!dingtalk?.connected && <Typography.Paragraph type="warning">请先完成钉钉连接。当前不阻断本地管理功能，但部门选择不可用。</Typography.Paragraph>}
    <Form form={form} layout="vertical" onFinish={save} className="settings-form">
      <Form.Item name="enabled" label="启用打卡奖励" valuePropName="checked"><Switch /></Form.Item>
      <Form.Item name="testMode" label="测试模式" valuePropName="checked"><Switch /></Form.Item>
      <Form.Item name="lateGraceMinutes" label="宽限分钟数"><InputNumber min={0} precision={0} /></Form.Item>
      <Form.Item label="奖励范围"><Space><Form.Item name="rewardMin" noStyle><InputNumber min={1} precision={0} /></Form.Item><span>—</span><Form.Item name="rewardMax" noStyle><InputNumber min={1} precision={0} /></Form.Item></Space></Form.Item>
      <Form.Item name="maxPerDay" label="每日上限"><InputNumber min={1} precision={0} /></Form.Item>
      <Form.Item name="onlyCheckin" label="仅上班打卡" valuePropName="checked"><Switch /></Form.Item>
      <Form.Item label="适用部门"><Select value={mode} onChange={setMode} options={[{ value: 'all', label: '全部部门' }, { value: 'selected', label: '指定部门' }]} style={{ width: 160 }} /></Form.Item>
      {mode === 'selected' && <Form.Item name="departmentIds" label="部门多选"><Select mode="multiple" disabled={!dingtalk?.connected} placeholder={dingtalk?.connected ? '选择部门' : '请先完成钉钉连接'} options={departments.map((d) => ({ value: String(d.dept_id), label: `${'　'.repeat(Number(d.depth || 0))}${d.name}` }))} /></Form.Item>}
      <Form.Item name="reason" label="奖励理由"><Input placeholder="打卡奖励" /></Form.Item>
    </Form>
  </Card>;
}

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
const fullTables = ['users', 'accounts', 'bob_tokens', 'ledger', 'redeems', 'redeem_cdks', 'mall_products', 'charity_projects', 'charity_contributions', 'attendance_reward_records', 'mall_opening_schedule', 'red_packet_activity', 'red_packet_items', 'content_faq', 'content_announcements', 'system_versions', 'user_feedback', 'audit_logs', 'system_settings'];
const backupHistoryKey = 'bob_admin_backup_history_v1';

function tableRowsFromMap(map = {}) {
  return Object.entries(map).map(([table, count]) => ({ table, count }));
}

function readBackupHistory() {
  try {
    return JSON.parse(localStorage.getItem(backupHistoryKey) || '[]');
  } catch {
    return [];
  }
}

function writeBackupHistory(rows) {
  localStorage.setItem(backupHistoryKey, JSON.stringify(rows.slice(0, 30)));
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
  const [history, setHistory] = useState(() => readBackupHistory());

  const remember = (row) => {
    const next = [{ ...row, id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}` }, ...history];
    setHistory(next.slice(0, 30));
    writeBackupHistory(next);
  };

  const exportBackup = async (mode) => {
    setBusy(true);
    setImportReport(null);
    try {
      const res = await fetch(`/admin/backup/export?mode=${mode}`, { credentials: 'include' });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?._meta) throw new Error(data?.error || '导出失败');
      const filename = backupFilename(mode);
      downloadJson(filename, data);
      const detail = { mode, filename, meta: data._meta };
      setExportDetail(detail);
      remember({ action: '导出', mode, filename, at: Math.floor(Date.now() / 1000), status: '完成' });
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
        const data = await api('/admin/backup/import', { method: 'POST', body: { backup: importDetail.backup, mode: importMode } });
        setImportReport(data.report || {});
        remember({ action: '导入', mode: importMode, filename: importDetail.filename, at: Math.floor(Date.now() / 1000), status: '完成' });
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
      <Typography.Text type="secondary">历史记录保存在当前浏览器，用于追溯最近导出和导入操作。</Typography.Text>
    </Card>
  </Space>;
}

export default function Integrations(props) {
  return <Tabs items={[{ key: 'ding', label: '钉钉与打卡', children: <Attendance {...props} /> }, { key: 'token', label: 'BOB Token', children: <Tokens /> }, { key: 'backup', label: '备份', children: <Backup /> }]} />;
}
