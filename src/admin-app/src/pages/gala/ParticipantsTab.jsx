import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Space,
  Table,
  Typography,
} from 'antd';
import { api, qs } from '../../api.js';
import { formatTs } from '../../utils.js';

const PAGE_SIZE = 100;
const MAX_BATCH_USERIDS = 2000;
const PG_INT_MAX = 2147483647;

function parseBatchUserids(rawText) {
  const seen = new Set();
  const list = [];
  for (const line of String(rawText || '').split(/\r?\n/)) {
    const uid = line.trim();
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    list.push(uid);
  }
  return list;
}

export default function ParticipantsTab({
  eventId,
  detail,
  galaVersion,
  canEdit,
  reload,
  handleError,
}) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const allActiveDingtalk = Boolean(Form.useWatch('all_active_dingtalk', form));
  const useridsText = Form.useWatch('userids_text', form);

  const [participants, setParticipants] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [removingId, setRemovingId] = useState(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const requestSeqRef = useRef(0);

  const parsedUserids = useMemo(() => parseBatchUserids(useridsText), [useridsText]);

  const loadParticipants = useCallback(async () => {
    if (!eventId) return;
    const seq = ++requestSeqRef.current;
    setLoading(true);
    setLoadingMore(false);
    try {
      const resp = await api(`/admin/gala/participants?${qs({ event_id: eventId, limit: PAGE_SIZE })}`);
      if (seq !== requestSeqRef.current) return;
      const list = Array.isArray(resp?.data) ? resp.data : [];
      setParticipants(list);
      setHasMore(list.length >= PAGE_SIZE);
    } catch (err) {
      if (seq !== requestSeqRef.current) return;
      handleError(err);
    } finally {
      if (seq === requestSeqRef.current) setLoading(false);
    }
  }, [eventId, handleError]);

  const loadMore = async () => {
    if (loading || loadingMore || !hasMore || participants.length === 0) return;
    const lastId = participants[participants.length - 1]?.id;
    if (!lastId) return;
    const seq = requestSeqRef.current;
    setLoadingMore(true);
    try {
      const resp = await api(
        `/admin/gala/participants?${qs({ event_id: eventId, after_id: lastId, limit: PAGE_SIZE })}`,
      );
      if (seq !== requestSeqRef.current) return;
      const list = Array.isArray(resp?.data) ? resp.data : [];
      setParticipants((prev) => {
        const seen = new Set(prev.map((item) => item.id));
        const appended = list.filter((item) => !seen.has(item.id));
        return [...prev, ...appended];
      });
      setHasMore(list.length >= PAGE_SIZE);
    } catch (err) {
      if (seq !== requestSeqRef.current) return;
      const versionChanged = handleError(err);
      if (versionChanged) loadParticipants();
    } finally {
      if (seq === requestSeqRef.current) setLoadingMore(false);
    }
  };

  useEffect(() => {
    setParticipants([]);
    setHasMore(false);
    loadParticipants();
  }, [eventId, galaVersion, loadParticipants]);

  useEffect(() => {
    if (!modalOpen) return;
    form.resetFields();
    form.setFieldsValue({
      all_active_dingtalk: false,
      userids_text: '',
      table_no: null,
    });
  }, [modalOpen, form]);

  const openAddModal = () => {
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
  };

  const handleAddSubmit = async (values) => {
    setSubmitting(true);
    try {
      const useAllActive = values.all_active_dingtalk === true;
      const payload = {
        event_id: eventId,
        gala_version: galaVersion,
      };
      if (values.table_no !== undefined && values.table_no !== null && values.table_no !== '') {
        payload.table_no = Number(values.table_no);
      }
      if (useAllActive) {
        payload.all_active_dingtalk = true;
      } else {
        payload.userids = parseBatchUserids(values.userids_text);
      }

      const resp = await api('/admin/gala/participants/add', {
        method: 'POST',
        body: payload,
      });
      const data = resp?.data || {};
      const added = Number(data.added || 0);
      const missing = Array.isArray(data.missing) ? data.missing : [];
      const skippedInvalid = Array.isArray(data.skipped_invalid) ? data.skipped_invalid : [];

      const parts = [`已新增 ${added} 名参与人`];
      if (missing.length > 0) {
        const preview = missing.slice(0, 5).join('、');
        parts.push(`${missing.length} 个未找到（${preview}${missing.length > 5 ? ' 等' : ''}）`);
      }
      if (skippedInvalid.length > 0) {
        parts.push(`跳过 ${skippedInvalid.length} 个异常 ID`);
      }
      message.success(parts.join('，'));

      closeModal();
      await Promise.all([loadParticipants(), reload()]);
    } catch (err) {
      const versionChanged = handleError(err);
      if (versionChanged) {
        closeModal();
        loadParticipants();
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemove = async (record) => {
    setRemovingId(record.id);
    try {
      const resp = await api('/admin/gala/participants/remove', {
        method: 'POST',
        body: {
          event_id: eventId,
          participant_id: record.id,
          gala_version: record.gala_version || galaVersion,
        },
      });
      const removed = Number(resp?.data?.removed || 0);
      if (removed > 0) {
        message.success('已移除参与人');
      } else {
        message.info('该参与人已不在名单中');
      }
      await Promise.all([loadParticipants(), reload()]);
    } catch (err) {
      const versionChanged = handleError(err);
      if (versionChanged) loadParticipants();
    } finally {
      setRemovingId(null);
    }
  };

  const hasDepartment = participants.some((item) => Boolean(item?.department || item?.dept_name));

  // 参与人 Tab 绝不展示任何预留相关字段（例如超管响应中可能附带的 is_reserved）。
  const columns = [
    {
      title: 'userid',
      dataIndex: 'userid',
      width: 200,
      ellipsis: true,
    },
    {
      title: '姓名',
      dataIndex: 'name',
      width: 140,
      ellipsis: true,
      render: (value) => value || '-',
    },
  ];

  if (hasDepartment) {
    columns.push({
      title: '部门',
      key: 'department',
      width: 160,
      ellipsis: true,
      render: (_, record) => record.department || record.dept_name || '-',
    });
  }

  columns.push(
    {
      title: '桌号',
      dataIndex: 'table_no',
      width: 100,
      render: (value) => (value === null || value === undefined || value === '' ? '-' : value),
    },
    {
      title: '加入时间',
      dataIndex: 'joined_at',
      width: 180,
      render: formatTs,
    },
  );

  if (canEdit) {
    columns.push({
      title: '操作',
      key: 'actions',
      fixed: 'right',
      width: 90,
      render: (_, record) => (
        <Popconfirm
          title="确认移除该参与人？"
          description={`${record.name || record.userid}（${record.userid}）将从参与名单中移除`}
          okText="确认移除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          onConfirm={() => handleRemove(record)}
        >
          <Button size="small" danger loading={removingId === record.id}>
            移除
          </Button>
        </Popconfirm>
      ),
    });
  }

  const totalCount = Number(detail?.participant_count ?? participants.length);

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Typography.Text type="secondary">
          共 {totalCount} 名参与人
          {participants.length > 0 && participants.length < totalCount ? `（已加载 ${participants.length} 人）` : ''}
        </Typography.Text>
        <Space>
          <Button onClick={loadParticipants} loading={loading}>
            刷新名单
          </Button>
          {canEdit && (
            <Button type="primary" onClick={openAddModal}>
              添加参与人
            </Button>
          )}
        </Space>
      </div>

      <Table
        rowKey="id"
        loading={loading}
        dataSource={participants}
        columns={columns}
        pagination={false}
        scroll={{ x: hasDepartment ? 870 : 710 }}
        locale={{ emptyText: '暂无参与人' }}
      />

      {(participants.length > 0 || hasMore) && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <Typography.Text type="secondary">已加载 {participants.length} 名参与人</Typography.Text>
          {hasMore ? (
            <Button onClick={loadMore} loading={loadingMore}>
              加载更多
            </Button>
          ) : (
            <Typography.Text type="secondary">已显示全部参与人</Typography.Text>
          )}
        </div>
      )}

      <Modal
        title="添加参与人"
        open={modalOpen}
        onCancel={closeModal}
        onOk={() => form.submit()}
        okText="确认添加"
        cancelText="取消"
        confirmLoading={submitting}
        width={540}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={handleAddSubmit}>
          <Form.Item name="all_active_dingtalk" valuePropName="checked" style={{ marginBottom: 12 }}>
            <Checkbox>一键添加全部在职钉钉员工</Checkbox>
          </Form.Item>

          {allActiveDingtalk ? (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message="将自动导入当前所有在职的钉钉同步员工，已在名单中的员工会自动跳过。"
            />
          ) : (
            <Form.Item
              name="userids_text"
              label="按 userid 批量添加"
              extra={`一行一个 userid，自动去空行去重，单次最多 ${MAX_BATCH_USERIDS} 个（当前已识别 ${parsedUserids.length} 个）`}
              rules={[
                {
                  validator: (_, value) => {
                    const list = parseBatchUserids(value);
                    if (list.length === 0) {
                      return Promise.reject(new Error('请至少填写一个 userid'));
                    }
                    if (list.length > MAX_BATCH_USERIDS) {
                      return Promise.reject(new Error(`单次最多添加 ${MAX_BATCH_USERIDS} 个 userid`));
                    }
                    return Promise.resolve();
                  },
                },
              ]}
            >
              <Input.TextArea
                rows={6}
                placeholder={'每行输入一个 userid，例如：\nuser_001\nuser_002'}
              />
            </Form.Item>
          )}

          <Form.Item
            name="table_no"
            label="桌号（选填）"
            extra="填写正整数，留空则不分配桌号"
            rules={[
              {
                validator: (_, value) => {
                  if (value === undefined || value === null || value === '') return Promise.resolve();
                  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > PG_INT_MAX) {
                    return Promise.reject(new Error('桌号必须为正整数'));
                  }
                  return Promise.resolve();
                },
              },
            ]}
          >
            <InputNumber
              min={1}
              max={PG_INT_MAX}
              step={1}
              precision={0}
              style={{ width: '100%' }}
              placeholder="选填，例如：1"
            />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
