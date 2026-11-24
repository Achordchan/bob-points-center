import { useEffect, useRef, useState } from 'react';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import { App as AntApp, Button, DatePicker, Form, Input, InputNumber, Modal, Select, Space, Tag } from 'antd';
import { api } from '../../api.js';
import { galaErrorText, isGalaVersionError } from './errors.js';

dayjs.extend(customParseFormat);

export const EVENT_STATUS_LABELS = {
  draft: '草稿',
  live: '进行中',
  ended: '已结束',
};

export const EVENT_STATUS_COLORS = {
  draft: 'blue',
  live: 'green',
  ended: 'default',
};

export const EVENT_STATUS_OPTIONS = Object.entries(EVENT_STATUS_LABELS).map(([value, label]) => ({
  value,
  label,
}));

function parseEventDate(value) {
  if (typeof value !== 'string' || !value) return null;
  const parsed = dayjs(value, 'YYYY-MM-DD', true);
  return parsed.isValid() ? parsed : null;
}

export default function EventFormModal({
  open,
  event,
  galaVersion,
  segments = [],
  segmentsLoading = false,
  onCancel,
  onSuccess,
  onVersionMismatch,
}) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [capturedVersion, setCapturedVersion] = useState('');
  const wasOpenRef = useRef(false);
  const isEdit = Boolean(event?.id);
  const rawEventDate = isEdit && typeof event?.event_date === 'string' ? event.event_date : '';
  const hasNonStandardEventDate = Boolean(rawEventDate.trim()) && !parseEventDate(rawEventDate);

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      setCapturedVersion('');
      return;
    }
    if (!wasOpenRef.current) {
      wasOpenRef.current = true;
      setCapturedVersion(
        typeof galaVersion === 'string'
          ? galaVersion
          : typeof event?.gala_version === 'string'
            ? event.gala_version
            : '',
      );
    }
  }, [open, galaVersion, event]);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    if (event?.id) {
      form.setFieldsValue({
        title: event.title || '',
        event_date: parseEventDate(event.event_date),
        total_budget: Number.isSafeInteger(Number(event.total_budget)) ? Number(event.total_budget) : 0,
        status: event.status || 'draft',
        enabled_segments: Array.isArray(event.enabled_segments) ? event.enabled_segments : [],
      });
    } else {
      form.setFieldsValue({
        title: '',
        event_date: null,
        total_budget: 0,
        enabled_segments: segments.map((s) => s.key),
      });
    }
  }, [open, event, form]);

  useEffect(() => {
    if (!open || isEdit || segments.length === 0) return;
    if (!form.isFieldTouched('enabled_segments')) {
      const current = form.getFieldValue('enabled_segments');
      if (!Array.isArray(current) || current.length === 0) {
        form.setFieldValue('enabled_segments', segments.map((s) => s.key));
      }
    }
  }, [open, isEdit, segments, form]);

  const handleSubmit = async (values) => {
    setSubmitting(true);
    try {
      const baseBody = {
        title: String(values.title || '').trim(),
        total_budget: Number(values.total_budget ?? 0),
        enabled_segments: Array.isArray(values.enabled_segments) ? values.enabled_segments : [],
      };
      if (isEdit) {
        const body = {
          ...baseBody,
          id: event.id,
          status: values.status,
          gala_version: capturedVersion,
        };
        if (form.isFieldTouched('event_date')) {
          body.event_date = values.event_date ? values.event_date.format('YYYY-MM-DD') : null;
        }
        const resp = await api('/admin/gala/events/update', {
          method: 'POST',
          body,
        });
        message.success('年会活动已更新');
        onSuccess?.(resp?.data || null);
      } else {
        const resp = await api('/admin/gala/events/create', {
          method: 'POST',
          body: {
            ...baseBody,
            event_date: values.event_date ? values.event_date.format('YYYY-MM-DD') : null,
          },
        });
        message.success('年会活动已创建');
        onSuccess?.(resp?.data || null);
      }
    } catch (err) {
      if (isGalaVersionError(err)) {
        message.warning('数据已变化，已刷新');
        onVersionMismatch?.();
      } else {
        message.error(galaErrorText(err));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const segmentOptions = segments.map((s) => ({
    value: s.key,
    label: s.label,
    drawable: Boolean(s.drawable),
  }));

  const selectAllSegments = () => {
    form.setFieldValue('enabled_segments', segments.map((s) => s.key));
  };

  const clearSegments = () => {
    form.setFieldValue('enabled_segments', []);
  };

  return (
    <Modal
      title={isEdit ? `编辑年会活动 #${event.id}` : '新建年会活动'}
      open={open}
      onCancel={onCancel}
      onOk={() => form.submit()}
      okText={isEdit ? '保存' : '创建'}
      cancelText="取消"
      confirmLoading={submitting}
      width={600}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" onFinish={handleSubmit}>
        <Form.Item
          name="title"
          label="活动标题"
          rules={[
            { required: true, whitespace: true, message: '请填写活动标题' },
            { max: 80, message: '活动标题最多 80 字' },
          ]}
        >
          <Input placeholder="例如：2026 公司年会" maxLength={80} />
        </Form.Item>

        <Form.Item
          name="event_date"
          label="活动日期"
          extra={hasNonStandardEventDate ? `当前值：${rawEventDate}，未修改则保持不变` : undefined}
        >
          <DatePicker format="YYYY-MM-DD" style={{ width: '100%' }} placeholder="请选择活动日期（可选）" allowClear />
        </Form.Item>

        <Form.Item
          name="total_budget"
          label="总预算（BOB 币）"
          extra="填写整数 BOB 币，0 表示不限预算"
          rules={[
            { required: true, message: '请输入总预算（0 表示不限）' },
            {
              validator: (_, value) => {
                if (value === undefined || value === null || value === '') return Promise.resolve();
                if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
                  return Promise.reject(new Error('总预算必须为非负整数'));
                }
                return Promise.resolve();
              },
            },
          ]}
        >
          <InputNumber min={0} step={1} precision={0} style={{ width: '100%' }} placeholder="0 表示不限" />
        </Form.Item>

        {isEdit && (
          <Form.Item
            name="status"
            label="活动状态"
            rules={[{ required: true, message: '请选择活动状态' }]}
          >
            <Select options={EVENT_STATUS_OPTIONS} />
          </Form.Item>
        )}

        <Form.Item
          name="enabled_segments"
          label={
            <Space size={8}>
              <span>启用环节</span>
              {segments.length > 0 && (
                <>
                  <Button type="link" size="small" style={{ padding: 0, height: 'auto' }} onClick={selectAllSegments}>
                    全选
                  </Button>
                  <Button type="link" size="small" style={{ padding: 0, height: 'auto' }} onClick={clearSegments}>
                    清空
                  </Button>
                </>
              )}
            </Space>
          }
        >
          <Select
            mode="multiple"
            allowClear
            loading={segmentsLoading}
            placeholder="请选择启用的年会环节"
            optionFilterProp="label"
            options={segmentOptions}
            optionRender={(option) => (
              <Space size={6}>
                <span>{option.data.label}</span>
                {option.data.drawable && <Tag color="gold">可抽签</Tag>}
              </Space>
            )}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
