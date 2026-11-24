import { useEffect, useState } from 'react';
import { App as AntApp, Button, Form, Input, InputNumber, Modal, Space, Table, Typography } from 'antd';
import { api } from '../../api.js';
import { amountText, localTablePagination } from '../../utils.js';

export default function PoolsTab({
  eventId,
  detail,
  galaVersion,
  canEdit,
  loading,
  reload,
  handleError,
}) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const [editing, setEditing] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  // 奖池 Tab 只展示公开奖池（is_reserved === 0），绝不展示预留奖池。
  const publicPools = (Array.isArray(detail?.pools) ? detail.pools : []).filter(
    (pool) => Number(pool?.is_reserved) === 0,
  );

  const modalOpen = Boolean(editing);
  const editingPool = editing?.pool || null;
  const isEdit = Boolean(editingPool?.id);

  useEffect(() => {
    if (!editing) return;
    form.resetFields();
    if (editing.pool?.id) {
      form.setFieldsValue({
        name: editing.pool.name || '',
        sponsor: editing.pool.sponsor || '',
        budget: Number.isSafeInteger(Number(editing.pool.budget)) ? Number(editing.pool.budget) : 0,
      });
    } else {
      form.setFieldsValue({
        name: '',
        sponsor: '',
        budget: 0,
      });
    }
  }, [editing, form]);

  const openCreate = () => {
    setEditing({
      pool: null,
      version: typeof galaVersion === 'string' ? galaVersion : '',
    });
  };

  const openEdit = (pool) => {
    setEditing({
      pool,
      version: typeof galaVersion === 'string' ? galaVersion : '',
    });
  };

  const closeModal = () => {
    setEditing(null);
  };

  const handleSubmit = async (values) => {
    if (!editing) return;
    const targetPool = editing.pool;
    const version = editing.version;
    setSubmitting(true);
    try {
      const name = String(values.name || '').trim();
      const sponsor = String(values.sponsor || '').trim();
      const budget = Number(values.budget);

      if (targetPool?.id) {
        await api('/admin/gala/pools/update', {
          method: 'POST',
          body: {
            id: targetPool.id,
            name,
            sponsor,
            budget,
            gala_version: version,
          },
        });
        message.success('奖池已更新');
      } else {
        await api('/admin/gala/pools/create', {
          method: 'POST',
          body: {
            event_id: eventId,
            name,
            sponsor,
            budget,
            gala_version: version,
          },
        });
        message.success('奖池已创建');
      }
      closeModal();
      await reload();
    } catch (err) {
      const versionChanged = handleError(err);
      if (versionChanged) closeModal();
    } finally {
      setSubmitting(false);
    }
  };

  const columns = [
    {
      title: '名称',
      dataIndex: 'name',
      ellipsis: true,
    },
    {
      title: '赞助方',
      dataIndex: 'sponsor',
      ellipsis: true,
      render: (value) => value || '-',
    },
    {
      title: '预算',
      dataIndex: 'budget',
      width: 140,
      render: amountText,
    },
    {
      title: '已分配',
      dataIndex: 'allocated',
      width: 140,
      render: amountText,
    },
    {
      title: '剩余',
      dataIndex: 'remaining',
      width: 140,
      render: amountText,
    },
  ];

  if (canEdit) {
    columns.push({
      title: '操作',
      key: 'actions',
      fixed: 'right',
      width: 90,
      render: (_, record) => (
        <Button size="small" onClick={() => openEdit(record)}>
          编辑
        </Button>
      ),
    });
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Typography.Text type="secondary">
          共 {publicPools.length} 个奖池，预算合计 {amountText(detail?.budget_summary?.pools_budget || 0)}
          {Number(detail?.total_budget) > 0 ? ` / 总预算 ${amountText(detail.total_budget)}` : ''}
        </Typography.Text>
        {canEdit && (
          <Button type="primary" onClick={openCreate}>
            新建奖池
          </Button>
        )}
      </div>

      <Table
        rowKey="id"
        loading={loading}
        dataSource={publicPools}
        columns={columns}
        pagination={localTablePagination('个奖池')}
        scroll={{ x: 680 }}
        locale={{ emptyText: '暂无奖池' }}
      />

      <Modal
        title={isEdit ? `编辑奖池 #${editingPool.id}` : '新建奖池'}
        open={modalOpen}
        onCancel={closeModal}
        onOk={() => form.submit()}
        okText={isEdit ? '保存' : '创建'}
        cancelText="取消"
        confirmLoading={submitting}
        width={520}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit}>
          <Form.Item
            name="name"
            label="奖池名称"
            rules={[
              { required: true, whitespace: true, message: '请填写奖池名称' },
              { max: 40, message: '奖池名称最多 40 字' },
            ]}
          >
            <Input placeholder="例如：阳光普照奖池" maxLength={40} />
          </Form.Item>

          <Form.Item
            name="sponsor"
            label="赞助方"
            rules={[{ max: 40, message: '赞助方最多 40 字' }]}
          >
            <Input placeholder="选填，例如：管理层赞助" maxLength={40} />
          </Form.Item>

          <Form.Item
            name="budget"
            label="预算（BOB 币）"
            extra={
              isEdit
                ? `填写非负整数 BOB 币，不能低于已分配额（${amountText(editingPool.allocated)}）`
                : '填写非负整数 BOB 币，允许为 0'
            }
            rules={[
              { required: true, message: '请输入奖池预算' },
              {
                validator: (_, value) => {
                  if (value === undefined || value === null || value === '') return Promise.resolve();
                  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
                    return Promise.reject(new Error('奖池预算必须为非负整数'));
                  }
                  return Promise.resolve();
                },
              },
            ]}
          >
            <InputNumber min={0} step={1} precision={0} style={{ width: '100%' }} placeholder="请输入整数金额" />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
