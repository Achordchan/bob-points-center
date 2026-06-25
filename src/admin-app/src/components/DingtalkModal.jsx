import { useEffect } from 'react';
import { Alert, Form, Input, Modal, Space, Tag, Typography } from 'antd';

export default function DingtalkModal({ open, state, loading, onCancel, onRefresh, onSave }) {
  const [form] = Form.useForm();
  const data = state?.data || {};

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      corpId: data.corpId || '',
      appKey: data.appKey || '',
      appSecret: '',
      agentId: data.agentId || '',
    });
  }, [open, data.corpId, data.appKey, data.agentId, form]);

  return (
    <Modal
      title="钉钉连接"
      open={open}
      confirmLoading={loading}
      onCancel={onCancel}
      onOk={() => form.submit()}
      okText="保存钉钉连接"
      cancelText="关闭"
      width={760}
      afterOpenChange={(visible) => visible && onRefresh?.()}
    >
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <Alert
          type={state?.connected ? 'success' : 'warning'}
          showIcon
          message={<Space><span>{state?.connected ? '已连接' : '未连接'}</span><Tag>{data.organizationName || data.corpId || '未配置组织'}</Tag></Space>}
          description={state?.connected ? '通讯录、打卡奖励和部门选择可用。' : (state?.error || '请先完成钉钉连接。')}
        />
        <Typography.Text type="secondary">AppSecret 不会明文回显；留空保存表示沿用当前密钥。</Typography.Text>
        <Form form={form} layout="vertical" onFinish={onSave}>
          <Form.Item label="组织名称" extra="保存并校验连接后，系统会从钉钉自动识别组织名称。">
            <Input disabled readOnly value={data.organizationName || ''} placeholder="保存并校验连接后自动识别" />
          </Form.Item>
          <Form.Item label="CorpId" name="corpId"><Input placeholder="钉钉企业 CorpId" /></Form.Item>
          <Form.Item label="AppKey" name="appKey"><Input placeholder="钉钉应用 AppKey" /></Form.Item>
          <Form.Item label="AppSecret" name="appSecret" extra={data.appSecretConfigured ? `当前已配置：${data.appSecretMasked || '已隐藏'}` : '当前未配置密钥'}>
            <Input.Password placeholder="留空表示不修改现有密钥" />
          </Form.Item>
          <Form.Item label="AgentId" name="agentId"><Input placeholder="钉钉应用 AgentId" /></Form.Item>
        </Form>
      </Space>
    </Modal>
  );
}
