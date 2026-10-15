import { useEffect, useState } from 'react';
import { Alert, App, Avatar, Button, Card, Descriptions, Drawer, Empty, Form, Input, InputNumber, Modal, Select, Space, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import { api, qs, translateErrorMessage } from '../api.js';
import DataToolbar from '../components/DataToolbar.jsx';
import { amountText, formatTs, orderAmount } from '../utils.js';
import { hasPermission } from '../permissions.js';


function yesNo(value) {
  return Number(value) === 1 ? '是' : '否';
}

function listText(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join('、') || '-';
  return value || '-';
}

function objectText(value) {
  if (!value || typeof value !== 'object') return '-';
  const entries = Object.entries(value);
  if (!entries.length) return '-';
  return entries.map(([key, val]) => `${key}：${typeof val === 'object' ? JSON.stringify(val) : String(val)}`).join('；');
}

function operationStatusTag(code) {
  if (code === null || code === undefined || code === '' || Number(code) === 0) return <Tag>已记录</Tag>;
  const n = Number(code);
  if (n >= 200 && n < 300) return <Tag color="green">成功</Tag>;
  if (n >= 400) return <Tag color="red">失败</Tag>;
  return <Tag color="orange">需确认</Tag>;
}

function operationEventTag(value) {
  const label = String(value || '').trim();
  return <Tag color={label.includes('危险') || label.includes('删除') ? 'red' : 'blue'}>{label || '后台操作'}</Tag>;
}

// 外部活动账号没有钉钉身份：一律用 source 判断，不依赖 userid 前缀。
function isExternalUser(user) {
  return user?.source === 'external';
}

function externalStatusTag(status) {
  return status === 'disabled' ? <Tag color="red">已禁用</Tag> : <Tag color="green">正常</Tag>;
}

function dingtalkItems(profile) {
  if (!profile) return [];
  return [
    { key: 'avatar', label: '头像', children: profile.avatar ? <Avatar src={profile.avatar} size={48} /> : '-' },
    { key: 'name', label: '钉钉姓名', children: profile.name || '-' },
    { key: 'userid', label: 'Userid', children: profile.userid || '-' },
    { key: 'unionid', label: 'UnionId', children: profile.unionid || '-' },
    { key: 'dept', label: '所属部门', children: listText(profile.dept_names) },
    { key: 'title', label: '职位', children: profile.title || '-' },
    { key: 'job', label: '工号', children: profile.job_number || '-' },
    { key: 'mobile', label: '手机', children: profile.mobile || '-' },
    { key: 'telephone', label: '座机', children: profile.telephone || '-' },
    { key: 'email', label: '邮箱', children: profile.email || '-' },
    { key: 'org_email', label: '企业邮箱', children: profile.org_email || '-' },
    { key: 'work_place', label: '办公地点', children: profile.work_place || '-' },
    { key: 'hired_date', label: '入职时间', children: profile.hired_date ? formatTs(profile.hired_date) : '-' },
    { key: 'active', label: '账号状态', children: Number(profile.active) === 1 ? <Tag color="green">在职启用</Tag> : <Tag>未启用</Tag> },
    { key: 'is_admin', label: '钉钉管理员', children: yesNo(profile.is_admin) },
    { key: 'is_boss', label: '主管', children: yesNo(profile.is_boss) },
    { key: 'exclusive', label: '专属账号', children: yesNo(profile.exclusive_account) },
    { key: 'leader', label: '部门负责人信息', children: objectText(profile.leader_in_dept) },
    { key: 'extension', label: '扩展信息', children: objectText(profile.extension) },
    { key: 'remark', label: '备注', children: profile.remark || '-' },
    { key: 'updated', label: '最近同步', children: formatTs(profile.updated_at) },
  ];
}

export default function Users({ me }) {
  const { message, modal } = App.useApp();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(30);
  const [keyword, setKeyword] = useState('');
  // 来源筛选：区分钉钉员工与对外活动外部账号（外部账号可整批清理）。
  const [source, setSource] = useState('');
  const [selected, setSelected] = useState([]);
  const [selectedUsers, setSelectedUsers] = useState({});
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [op, setOp] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState([]);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [roleTarget, setRoleTarget] = useState(null);
  const [notifyTarget, setNotifyTarget] = useState(null);
  const [notifyLoading, setNotifyLoading] = useState(false);
  const [notifyResult, setNotifyResult] = useState(null);
  const [resetTarget, setResetTarget] = useState(null);
  const [resetLoading, setResetLoading] = useState(false);
  const [passwordTarget, setPasswordTarget] = useState(null);
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [roles, setRoles] = useState([]);
  const [form] = Form.useForm();
  const [notifyForm] = Form.useForm();
  const [resetForm] = Form.useForm();
  const [passwordForm] = Form.useForm();

  const normalizeKeyword = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const canGrant = hasPermission(me, 'users:grant');
  const canDeduct = hasPermission(me, 'users:deduct');
  const canDelete = me?.isSuperAdmin === true;
  const canEdit = hasPermission(me, 'users:edit');
  const canAssignRole = me?.isSuperAdmin === true;
  const canNotify = hasPermission(me, 'messages:edit');

  const load = async (nextPage = page, nextKeyword = keyword, nextPageSize = pageSize) => {
    setLoading(true);
    try {
      const data = await api(`/admin/users?${qs({ page: nextPage, pageSize: nextPageSize, keyword: normalizeKeyword(nextKeyword), source })}`);
      const nextRows = data.data || [];
      setRows(nextRows);
      setSelectedUsers((prev) => {
        const next = { ...prev };
        nextRows.forEach((row) => {
          if (selected.includes(row.userid)) next[row.userid] = row;
        });
        return next;
      });
      setTotal(data.total || 0);
      setPage(data.page || nextPage);
      setPageSize(data.pageSize || nextPageSize);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      load(1, keyword).catch((e) => message.error(e.message));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [keyword, source]);

  useEffect(() => {
    if (!canAssignRole) return;
    api('/admin/roles').then((data) => setRoles((data.data || []).filter((role) => Number(role.is_enabled) === 1))).catch(() => null);
  }, [canAssignRole]);

  const openDetail = async (userid) => {
    const data = await api(`/admin/users/${encodeURIComponent(userid)}`);
    setDetail(data.data);
  };

  const rememberSelectedRows = (keys, selectedRows = []) => {
    const nextKeys = keys.map(String);
    setSelected(nextKeys);
    setSelectedUsers((prev) => {
      const next = {};
      nextKeys.forEach((userid) => {
        const known = selectedRows.find((row) => String(row.userid) === userid) || rows.find((row) => String(row.userid) === userid) || prev[userid];
        next[userid] = known || { userid };
      });
      return next;
    });
  };

  const clearSelected = () => {
    setSelected([]);
    setSelectedUsers({});
  };

  const recipientRows = op?.userid
    ? [rows.find((row) => row.userid === op.userid) || selectedUsers[op.userid] || { userid: op.userid }]
    : selected.map((userid) => selectedUsers[userid] || rows.find((row) => row.userid === userid) || { userid });

  const notifyCandidates = notifyTarget?.userid
    ? [notifyTarget]
    : selected.map((userid) => selectedUsers[userid] || rows.find((row) => row.userid === userid) || { userid });
  // 外部账号没有钉钉身份，收不到钉钉消息，发送前先排除。
  const notifyRows = notifyCandidates.filter((user) => !isExternalUser(user));
  const notifyExcludedCount = notifyCandidates.length - notifyRows.length;


  const postBatchOperation = async (path, body) => {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || data?.error) throw new Error(translateErrorMessage(data?.error || `HTTP ${res.status}`));
    return data || {};
  };

  const showBatchResult = (data, successText) => {
    const results = Array.isArray(data?.results) ? data.results : [];
    const okCount = results.length ? results.filter((item) => item.ok).length : Number(data?.count || 0);
    const failed = results.filter((item) => !item.ok);
    if (!failed.length && data?.ok !== false) {
      message.success(successText);
      return;
    }
    modal.warning({
      title: '部分用户处理失败',
      content: <Space direction="vertical" style={{ width: '100%' }}>
        <div>成功 {okCount} 人，失败 {failed.length} 人。</div>
        <div className="batch-recipient-list">{failed.slice(0, 20).map((item) => <Tag color="red" key={item.userid}>{item.name ? `${item.name}（${item.userid}）` : item.userid}：{translateErrorMessage(item.error || '处理失败')}</Tag>)}</div>
      </Space>,
      okText: '知道了',
    });
  };

  const selectAllMatchedUsers = async () => {
    setLoading(true);
    try {
      const first = await api(`/admin/users?${qs({ page: 1, pageSize: 100, keyword: normalizeKeyword(keyword), source })}`);
      const totalCount = Number(first.total || 0);
      const allRows = [...(first.data || [])];
      const pages = Math.ceil(totalCount / 100);
      for (let current = 2; current <= pages; current += 1) {
        const data = await api(`/admin/users?${qs({ page: current, pageSize: 100, keyword: normalizeKeyword(keyword), source })}`);
        allRows.push(...(data.data || []));
      }
      const keys = [...new Set(allRows.map((row) => String(row.userid || '')).filter(Boolean))];
      setSelected(keys);
      setSelectedUsers(Object.fromEntries(allRows.map((row) => [String(row.userid), row])));
      message.success(`已按当前搜索条件选中 ${keys.length} 人`);
    } catch (err) {
      message.error(err.message || '全选失败');
    } finally {
      setLoading(false);
    }
  };

  const submitOp = async (values) => {
    const userids = op.userid ? [op.userid] : selected;
    const path = op.type === 'grant' ? '/admin/ledger/grant-batch' : '/admin/redeem/deduct-batch';
    const body = op.type === 'grant'
      ? { userids, amount: values.amount, reason: values.reason || '后台发币', refId: values.refId || undefined }
      : { userids, amount: values.amount, product_name: values.reason };
    const data = await postBatchOperation(path, body);
    showBatchResult(data, op.type === 'grant' ? '发币完成' : '减币完成');
    if (!op.userid) clearSelected();
    setOp(null);
    await load();
    if (detail?.user?.userid) await openDetail(detail.user.userid);
  };

  const roleCandidates = roleTarget?.userid
    ? [roleTarget]
    : selected.map((userid) => selectedUsers[userid] || rows.find((row) => row.userid === userid) || { userid });
  // 外部账号不能被分配后台角色（后端也会拒绝），但允许取消历史上误挂的角色，所以目标里保留它们，
  // 只在分配（roleId 非空）时排除。
  const roleTargets = roleCandidates;
  const roleExternalCount = roleTargets.filter((user) => isExternalUser(user)).length;
  const onlyExternalRoleTargets = roleTargets.length > 0 && roleExternalCount === roleTargets.length;

  const assignRole = async (roleId) => {
    const role = roles.find((item) => String(item.id) === String(roleId));
    const roleName = role?.name || '无后台角色';
    const targets = roleTargets
      .filter((user) => !Number(user.is_fixed_admin))
      .filter((user) => !roleId || !isExternalUser(user));
    if (!targets.length) return message.warning('没有可修改角色的用户');
    const skippedExternal = roleId ? roleExternalCount : 0;
    modal.confirm({
      title: '确认修改后台角色？',
      content: `将把 ${targets.length} 个用户的后台角色改为「${roleName}」，权限会立即生效。${skippedExternal ? `另有 ${skippedExternal} 位外部账号不能分配角色，已跳过。` : ''}`,
      okText: '确认修改',
      cancelText: '取消',
      onOk: async () => {
        await Promise.all(targets.map((user) => api('/admin/users/assign-role', { method: 'POST', body: { userid: user.userid, roleId: roleId || null } })));
        message.success('后台角色已更新');
        setRoleTarget(null);
        if (!roleTarget?.userid) clearSelected();
        await load();
        if (detail?.user?.userid) await openDetail(detail.user.userid);
      },
    });
  };

  const openNotify = (target = {}) => {
    setNotifyTarget(target);
    setNotifyResult(null);
    notifyForm.resetFields();
  };

  const postNotify = async (body) => {
    const res = await fetch('/admin/users/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(translateErrorMessage(data?.error || `HTTP ${res.status}`));
    }
    return data || {};
  };

  const submitNotify = async (values) => {
    const userids = notifyRows.map((user) => user.userid);
    if (!userids.length) return message.warning(notifyExcludedCount ? '外部账号无法接收钉钉消息，没有可发送的接收人' : '请先选择接收人');
    setNotifyLoading(true);
    setNotifyResult(null);
    try {
      const data = await postNotify({ userids, title: values.title, content: values.content });
      const results = Array.isArray(data.results) ? data.results : [];
      const okCount = Number(data.success_count ?? results.filter((item) => item.ok).length);
      // 被后端跳过的（如外部账号）不算失败，单独统计。
      const skippedCount = Number(data.skipped_count ?? results.filter((item) => item.skipped).length);
      const failed = results.filter((item) => !item.ok && !item.skipped);
      const skippedText = skippedCount ? `，跳过 ${skippedCount}` : '';
      if (failed.length) {
        setNotifyResult({ okCount, total: data.count || userids.length, skippedCount, failed });
        message.error(`发送失败 ${failed.length} 人${skippedText ? `（跳过 ${skippedCount} 人）` : ''}，请查看失败原因`);
        return;
      }
      message.success(`消息发送完成：成功 ${okCount}/${data.count || userids.length}${skippedText}`);
      setNotifyTarget(null);
      if (!notifyTarget?.userid) clearSelected();
    } catch (err) {
      message.error(err.message || '消息发送失败');
    } finally {
      setNotifyLoading(false);
    }
  };


  const openResetUser = (user) => {
    setResetTarget(user);
    resetForm.resetFields();
  };

  const submitResetUser = async (values) => {
    const userid = resetTarget?.userid ? String(resetTarget.userid) : '';
    if (!userid) return message.warning('缺少用户 ID');
    if (values.confirm !== 'RESET_USER') return message.warning('确认口令不正确');
    setResetLoading(true);
    try {
      await api('/admin/data/reset-user', { method: 'POST', body: { userid } });
      message.success('该用户业务数据已清空');
      setResetTarget(null);
      await load(page, keyword, pageSize);
      await openDetail(userid);
    } catch (err) {
      message.error(err.message || '清空失败');
    } finally {
      setResetLoading(false);
    }
  };

  const openPasswordReset = (user) => {
    setPasswordTarget(user);
    passwordForm.resetFields();
  };

  const submitPasswordReset = async (values) => {
    const userid = passwordTarget?.userid ? String(passwordTarget.userid) : '';
    if (!userid) return message.warning('缺少用户 ID');
    setPasswordLoading(true);
    try {
      await api('/admin/users/external/reset-password', { method: 'POST', body: { userid, password: values.password } });
      message.success('密码已重置，失败计数与锁定已清除');
      setPasswordTarget(null);
      await openDetail(userid);
    } catch (err) {
      message.error(err.message || '重置密码失败');
    } finally {
      setPasswordLoading(false);
    }
  };

  const toggleExternalStatus = (user) => {
    const userid = String(user?.userid || '');
    if (!userid) return;
    const disable = user.external?.status !== 'disabled';
    modal.confirm({
      title: disable ? '确认禁用该外部账号？' : '确认启用该外部账号？',
      content: disable ? '禁用后该账号现有登录会话立即失效，且无法再登录。' : '启用后该账号可重新登录。',
      okText: disable ? '确认禁用' : '确认启用',
      okButtonProps: disable ? { danger: true } : undefined,
      cancelText: '取消',
      onOk: async () => {
        try {
          await api('/admin/users/external/set-status', { method: 'POST', body: { userid, status: disable ? 'disabled' : 'active' } });
          message.success(disable ? '账号已禁用' : '账号已启用');
          await load(page, keyword, pageSize);
          await openDetail(userid);
        } catch (err) {
          message.error(err.message || '操作失败');
        }
      },
    });
  };

  const deleteUsers = (userids) => {
    if (!userids.length) return;
    setDeleteTarget(userids);
  };

  const confirmDeleteUsers = async () => {
    setDeleteLoading(true);
    try {
      const data = await api('/admin/users/delete', { method: 'POST', body: { userids: deleteTarget } });
      message.success(`已删除 ${data.deleted || deleteTarget.length} 个用户`);
      clearSelected();
      setDeleteTarget([]);
      await load(1, keyword);
    } catch (err) {
      message.error(err.message || '删除失败');
    } finally {
      setDeleteLoading(false);
    }
  };

  const columns = [
    { title: '姓名', dataIndex: 'name', render: (v, r) => <Button type="link" onClick={() => openDetail(r.userid)}>{v || '-'}</Button> },
    { title: 'Userid', dataIndex: 'userid', ellipsis: true },
    {
      title: '来源',
      dataIndex: 'source',
      width: 240,
      render: (v, r) => (isExternalUser(r)
        ? <Space size={4} wrap><Tag color="purple">外部活动</Tag>{r.batch_id ? <Tag>{r.batch_id}</Tag> : null}{r.external_status === 'disabled' ? <Tag color="red">已禁用</Tag> : null}{r.phone ? <Typography.Text type="secondary">{r.phone}</Typography.Text> : null}</Space>
        : <Tag>钉钉</Tag>),
    },
    { title: '余额', dataIndex: 'balance', render: amountText, sorter: (a, b) => Number(a.balance) - Number(b.balance) },
    { title: '身份', render: (_, r) => r.is_fixed_admin ? <Tag color="gold">超级管理员</Tag> : (r.role?.name ? <Tag color="blue">{r.role.name}</Tag> : <Tag>普通用户</Tag>) },
    { title: '更新时间', dataIndex: 'updated_at', render: formatTs },
    { title: '操作', fixed: 'right', render: (_, r) => <Space>{canGrant && <Button onClick={() => { setOp({ type: 'grant', userid: r.userid }); form.resetFields(); }}>发币</Button>}{canDeduct && <Button onClick={() => { setOp({ type: 'deduct', userid: r.userid }); form.resetFields(); }}>减币</Button>}{canNotify && (isExternalUser(r)
      ? <Tooltip title="外部账号无钉钉，无法发送"><Button disabled>发消息</Button></Tooltip>
      : <Button onClick={() => openNotify(r)}>发消息</Button>)}</Space> },
  ];

  return (
    <Card>
      <DataToolbar keyword={keyword} onKeyword={setKeyword} onRefresh={() => load(1, keyword)} searchPlaceholder="姓名 / Userid / 手机号">
        <Select
          allowClear
          placeholder="来源"
          style={{ minWidth: 130 }}
          value={source || undefined}
          onChange={(value) => setSource(value || '')}
          options={[{ value: 'dingtalk', label: '钉钉员工' }, { value: 'external', label: '外部活动账号' }]}
        />
        {canEdit && <Button onClick={() => api('/admin/users/sync', { method: 'POST', body: {} }).then(() => { message.success('通讯录同步完成'); load(1, keyword); })}>同步通讯录</Button>}
        {selected.length > 0 && <Tag color="blue">已选 {selected.length} 人</Tag>}
        <Button onClick={selectAllMatchedUsers}>全选当前搜索结果</Button>
        {canGrant && <Button disabled={!selected.length} onClick={() => { setOp({ type: 'grant' }); form.resetFields(); }}>批量发币</Button>}
        {canDeduct && <Button disabled={!selected.length} onClick={() => { setOp({ type: 'deduct' }); form.resetFields(); }}>批量减币</Button>}
        {canNotify && <Button disabled={!selected.length} onClick={() => openNotify({})}>批量发消息</Button>}
        {canAssignRole && <Button disabled={!selected.length} onClick={() => setRoleTarget({})}>分配后台角色</Button>}
        {canDelete && <Button danger disabled={!selected.length} onClick={() => deleteUsers(selected)}>危险区：删除</Button>}
        <Button disabled={!selected.length} onClick={clearSelected}>清空选择</Button>
      </DataToolbar>
      <Table
        rowKey="userid"
        loading={loading}
        columns={columns}
        dataSource={rows}
        rowSelection={{ selectedRowKeys: selected, preserveSelectedRowKeys: true, onChange: rememberSelectedRows }}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          pageSizeOptions: [10, 20, 30, 50, 100],
          onChange: (nextPage, nextPageSize) => {
            const sizeChanged = nextPageSize !== pageSize;
            load(sizeChanged ? 1 : nextPage, keyword, nextPageSize);
          },
          showTotal: (n) => `共 ${n} 人`,
        }}
        scroll={{ x: 980 }}
      />
      <Drawer title="用户账户详情" open={Boolean(detail)} onClose={() => setDetail(null)} width={860}>
        {detail && <Tabs key={detail.user?.userid} items={[
          { key: 'info', label: '账户信息', children: <Space direction="vertical" style={{ width: '100%' }}>
            <Descriptions bordered column={2} items={[
              { key: 'name', label: '姓名', children: detail.user?.name || '-' },
              { key: 'userid', label: 'Userid', children: detail.user?.userid || '-' },
              { key: 'source', label: '来源', children: isExternalUser(detail.user) ? <Tag color="purple">外部活动账号</Tag> : <Tag>钉钉员工</Tag> },
              ...(isExternalUser(detail.user) ? [{ key: 'phone', label: '手机号', children: detail.user?.phone || '-' }] : []),
              { key: 'balance', label: '余额', children: amountText(detail.account?.balance) },
              { key: 'admin', label: '后台角色', children: detail.user?.is_fixed_admin ? <Tag color="gold">超级管理员</Tag> : (detail.user?.role?.name ? <Tag color="blue">{detail.user.role.name}</Tag> : '普通用户') },
            ]} />
            <Space wrap>
              {canAssignRole && (!isExternalUser(detail.user) || detail.user?.role) && !detail.user?.is_fixed_admin && <Button onClick={() => setRoleTarget(detail.user)}>修改后台角色</Button>}
              {canDelete && !detail.user?.is_fixed_admin && <Button danger onClick={() => openResetUser(detail.user)}>危险区：清空该用户业务数据</Button>}
            </Space>
          </Space> },
          isExternalUser(detail.user)
            ? { key: 'external', label: '外部账号', children: <Space direction="vertical" style={{ width: '100%' }}>
              <Descriptions bordered column={2} items={[
                { key: 'phone', label: '手机号', children: detail.user?.phone || '-' },
                { key: 'batch', label: '批次', children: detail.user?.external?.batch_id || '-' },
                { key: 'status', label: '状态', children: externalStatusTag(detail.user?.external?.status) },
                { key: 'last_login', label: '最近登录', children: formatTs(detail.user?.external?.last_login_at) },
              ]} />
              {canEdit && <Space wrap>
                <Button onClick={() => openPasswordReset(detail.user)}>重置密码</Button>
                <Button danger={detail.user?.external?.status !== 'disabled'} onClick={() => toggleExternalStatus(detail.user)}>{detail.user?.external?.status === 'disabled' ? '启用账号' : '禁用账号'}</Button>
              </Space>}
            </Space> }
            : { key: 'dingtalk', label: '钉钉资料', children: detail.dingtalk ? <Descriptions bordered column={2} items={dingtalkItems(detail.dingtalk)} /> : <Empty description="暂无钉钉同步资料，请先同步通讯录" /> },
          { key: 'ledger', label: '余额流水', children: <Table rowKey="id" size="small" dataSource={detail.ledger || []} pagination={false} columns={[{ title: '时间', dataIndex: 'created_at', render: formatTs }, { title: '金额', dataIndex: 'delta', render: amountText }, { title: '原因', render: (_, row) => row.display_reason || row.reason || '-', ellipsis: true }]} /> },
          { key: 'orders', label: '订单记录', children: <Table rowKey="exchange_id" size="small" dataSource={detail.redeems || []} pagination={false} columns={[{ title: '时间', dataIndex: 'created_at', render: formatTs }, { title: '商品', dataIndex: 'product_name' }, { title: '金额', render: (_, r) => amountText(orderAmount(r)) }, { title: '状态', render: (_, r) => r.fulfilled_at ? '已核销' : '未核销' }]} /> },
          { key: 'ops', label: '最近操作', children: <Table rowKey="id" size="small" dataSource={detail.operations || []} pagination={false} locale={{ emptyText: '暂无后台操作记录' }} columns={[{ title: '时间', dataIndex: 'created_at', render: formatTs }, { title: '操作', dataIndex: 'event_label', render: operationEventTag }, { title: '结果', dataIndex: 'status_code', render: operationStatusTag }, { title: '说明', dataIndex: 'message', ellipsis: true }]} /> },
        ]} />}
      </Drawer>
      <Modal title={op?.type === 'grant' ? '发币' : '减币'} open={Boolean(op)} onCancel={() => setOp(null)} onOk={() => form.submit()} okText="确认" cancelText="取消">
        {op && <Alert type={op.type === 'deduct' ? 'warning' : 'info'} showIcon message={`本次将${op.type === 'grant' ? '发币给' : '减币'} ${recipientRows.length} 人`} description={<div className="batch-recipient-list">{recipientRows.map((user) => <Tag key={user.userid}>{user.name ? `${user.name}（${user.userid}）` : user.userid}</Tag>)}</div>} style={{ marginBottom: 12 }} />}
        <Form form={form} layout="vertical" onFinish={submitOp}>
          <Form.Item label="金额" name="amount" rules={[{ required: true, message: '请输入金额' }]}><InputNumber min={1} precision={0} style={{ width: '100%' }} /></Form.Item>
          <Form.Item label="原因" name="reason" rules={op?.type === 'deduct' ? [{ required: true, message: '请输入减币原因' }] : []}><Input placeholder={op?.type === 'grant' ? '后台发币' : '请输入减币原因'} /></Form.Item>
          {op?.type === 'grant' && <Form.Item label="批次 / 备注 ID" name="refId"><Input placeholder="用于账本追溯，可选" /></Form.Item>}
        </Form>
      </Modal>
      <Modal
        title="分配后台角色"
        open={Boolean(roleTarget)}
        onCancel={() => setRoleTarget(null)}
        footer={null}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          {roleExternalCount > 0 && <Alert type="warning" showIcon message={`其中 ${roleExternalCount} 位外部账号不能分配后台角色，只能取消已有角色`} />}
          <Alert type="info" showIcon message={`将修改 ${roleTargets.length} 个用户的后台角色`} description={<div className="batch-recipient-list">{roleTargets.map((user) => <Tag key={user.userid}>{user.name ? `${user.name}（${user.userid}）` : user.userid}</Tag>)}</div>} />
          <Select
            placeholder="选择后台角色"
            disabled={!roleTargets.length}
            style={{ width: '100%' }}
            options={[{ value: null, label: '普通用户：无后台角色' }, ...(onlyExternalRoleTargets ? [] : roles.map((role) => ({ value: role.id, label: role.name })))]}
            onChange={assignRole}
          />
        </Space>
      </Modal>
      <Modal
        title="发送私聊消息"
        open={Boolean(notifyTarget)}
        onCancel={() => setNotifyTarget(null)}
        onOk={() => notifyForm.submit()}
        confirmLoading={notifyLoading}
        okText="发送"
        okButtonProps={{ disabled: !notifyRows.length }}
        cancelText="取消"
      >
        {notifyExcludedCount > 0 && <Alert type="info" showIcon message={`${notifyExcludedCount} 位外部账号无法接收钉钉消息，已排除`} style={{ marginBottom: 12 }} />}
        <Alert type="warning" showIcon message={`本次将发送给 ${notifyRows.length} 人`} description={<div className="batch-recipient-list">{notifyRows.map((user) => <Tag key={user.userid}>{user.name ? `${user.name}（${user.userid}）` : user.userid}</Tag>)}</div>} style={{ marginBottom: 12 }} />
        {notifyResult?.failed?.length > 0 && <Alert
          type="error"
          showIcon
          message={`发送未完成：成功 ${notifyResult.okCount}/${notifyResult.total}${notifyResult.skippedCount ? `，跳过 ${notifyResult.skippedCount}` : ''}`}
          description={<div className="batch-recipient-list">{notifyResult.failed.slice(0, 10).map((item) => <Tag color="red" key={item.userid}>{item.userid}：{translateErrorMessage(item.error || '发送失败')}</Tag>)}</div>}
          style={{ marginBottom: 12 }}
        />}
        <Form form={notifyForm} layout="vertical" onFinish={submitNotify}>
          <Form.Item label="标题" name="title"><Input placeholder="可留空" /></Form.Item>
          <Form.Item label="内容" name="content" rules={[{ required: true, message: '请输入消息内容' }]}><Input.TextArea rows={5} /></Form.Item>
        </Form>
      </Modal>

      <Modal
        title="重置外部账号密码"
        open={Boolean(passwordTarget)}
        onCancel={() => setPasswordTarget(null)}
        onOk={() => passwordForm.submit()}
        confirmLoading={passwordLoading}
        okText="确认重置"
        cancelText="取消"
      >
        <Alert type="info" showIcon message="重置后旧密码立即失效，同时清除登录失败计数与锁定。" style={{ marginBottom: 12 }} />
        {passwordTarget && <Tag>{passwordTarget.name ? `${passwordTarget.name}（${passwordTarget.userid}）` : passwordTarget.userid}</Tag>}
        <Form form={passwordForm} layout="vertical" onFinish={submitPasswordReset} style={{ marginTop: 12 }}>
          <Form.Item name="password" label="新密码" rules={[{ required: true, message: '请输入新密码' }, { min: 3, max: 64, message: '密码长度为 3-64 位' }]}>
            <Input.Password placeholder="3-64 位" autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title="清空该用户业务数据"
        open={Boolean(resetTarget)}
        onCancel={() => setResetTarget(null)}
        onOk={() => resetForm.submit()}
        confirmLoading={resetLoading}
        okText="确认清空"
        okButtonProps={{ danger: true }}
        cancelText="取消"
      >
        <Alert
          type="error"
          showIcon
          message="仅清空该用户的业务数据"
          description="会删除该用户余额流水、兑换订单、公益助力记录，并把余额重置为 0；不会删除用户本人、后台角色、商品、CDK 和系统配置。"
          style={{ marginBottom: 12 }}
        />
        {resetTarget && <Tag color="red">{resetTarget.name ? `${resetTarget.name}（${resetTarget.userid}）` : resetTarget.userid}</Tag>}
        <Form form={resetForm} layout="vertical" onFinish={submitResetUser} style={{ marginTop: 12 }}>
          <Form.Item name="confirm" label="输入确认口令 RESET_USER" rules={[{ required: true, message: '请输入确认口令' }]}>
            <Input placeholder="RESET_USER" autoComplete="off" />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title="确认删除用户？"
        open={deleteTarget.length > 0}
        onCancel={() => setDeleteTarget([])}
        onOk={confirmDeleteUsers}
        confirmLoading={deleteLoading}
        okText="确认删除"
        okButtonProps={{ danger: true }}
        cancelText="取消"
      >
        将删除 {deleteTarget.length} 个用户及关联账户、余额流水、核销记录，此操作不可撤销。
        <div className="batch-recipient-list">{deleteTarget.map((userid) => { const user = selectedUsers[userid] || rows.find((row) => row.userid === userid) || { userid }; return <Tag key={userid}>{user.name ? `${user.name}（${userid}）` : userid}</Tag>; })}</div>
      </Modal>
    </Card>
  );
}
