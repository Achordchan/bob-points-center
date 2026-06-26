import { useEffect, useMemo, useState } from 'react';
import { Alert, App, Button, Card, Collapse, Divider, Form, Input, Modal, Select, Space, Switch, Tabs, Typography } from 'antd';
import { api, qs } from '../api.js';
import { hasPermission } from '../permissions.js';
import { initDingtalkJsapi, isDingtalkClient } from '../utils/dingtalkJsapi.js';

const notifyTemplates = [
  { key: 'grant', label: '发币通知', vars: '{{name}} {{userid}} {{reason}} {{amount}} {{balance}}' },
  { key: 'deduct', label: '减币通知', vars: '{{name}} {{userid}} {{reason}} {{amount}} {{balance}} {{exchange_id}}' },
  { key: 'redeem', label: '核销通知', vars: '{{name}} {{userid}} {{product_name}} {{amount}} {{balance}} {{exchange_id}}' },
  { key: 'mall_buy', label: '下单通知', vars: '{{name}} {{userid}} {{product_name}} {{amount}} {{balance}}' },
  { key: 'transfer_out', label: '转出通知', vars: '{{name}} {{userid}} {{to_name}} {{amount}} {{balance}} {{transfer_id}}' },
  { key: 'transfer_in', label: '转入通知', vars: '{{name}} {{userid}} {{from_name}} {{amount}} {{balance}} {{transfer_id}}' },
  { key: 'red_packet', label: '红包通知', vars: '{{name}} {{userid}} {{amount}} {{balance}} {{activity_id}}' },
  { key: 'charity', label: '公益通知', vars: '{{name}} {{userid}} {{project_name}} {{amount}} {{balance}}' },
];

const groupTemplates = [
  { key: 'manual', label: '手动群通知', vars: '{{title}} {{content}}' },
  { key: 'mall_open', label: '商城开启', vars: '{{open_time}}' },
  { key: 'mall_open_remind', label: '商城开启提醒', vars: '{{open_time}}' },
  { key: 'mall_close_remind', label: '商城关闭提醒', vars: '{{close_time}}' },
  { key: 'stock_low', label: '库存告急', vars: '{{product_name}} {{stock}}' },
  { key: 'stock_soldout', label: '售罄通知', vars: '{{product_name}}' },
  { key: 'new_product', label: '新品上架', vars: '{{product_name}} {{amount}} {{stock}}' },
];

const colorOptions = [
  { value: 'blue', label: '蓝色' },
  { value: 'gray', label: '灰色' },
  { value: 'red', label: '红色' },
];

const defaultGroupConversationPresets = [
  { name: 'BOB大群', openConversationId: 'cidxEY0ywSnrjDytDeXzEscwg==' },
  { name: '测试群', openConversationId: 'cidGgW6mYLsdUyYN4rIuPvgYw==' },
];

const CUSTOM_CHANNEL_PRESET = '__custom__';

function normalizeChannelPresets(value, currentOpenConversationId = '', allowEmpty = false) {
  const normalize = (source) => {
    const seen = new Set();
    return source
      .map((item) => {
        const openConversationId = String(item?.openConversationId || '').trim();
        if (!openConversationId || seen.has(openConversationId)) return null;
        seen.add(openConversationId);
        return {
          name: String(item?.name || '未命名群聊').trim() || '未命名群聊',
          openConversationId,
        };
      })
      .filter(Boolean);
  };
  const source = Array.isArray(value) ? value : defaultGroupConversationPresets;
  let items = normalize(source);
  if (!items.length && !allowEmpty && source !== defaultGroupConversationPresets) {
    items = normalize(defaultGroupConversationPresets);
  }
  const seen = new Set();
  items.forEach((item) => seen.add(item.openConversationId));
  const current = String(currentOpenConversationId || '').trim();
  if (current && !seen.has(current)) {
    items.unshift({ name: '当前配置群', openConversationId: current });
  }
  return items;
}

function buildConversationPresetOptions(presets) {
  const items = Array.isArray(presets) ? presets : normalizeChannelPresets(presets);
  return [
    ...items.map((item) => ({ label: item.name, value: item.openConversationId })),
    { label: '自定义群', value: CUSTOM_CHANNEL_PRESET },
  ];
}

function matchConversationPreset(value, presets, useFirstWhenEmpty = false) {
  const normalized = Array.isArray(presets) ? presets : normalizeChannelPresets(presets);
  const current = String(value || '').trim();
  if (current && normalized.some((item) => item.openConversationId === current)) return current;
  if (!current && useFirstWhenEmpty && normalized[0]?.openConversationId) return normalized[0].openConversationId;
  return CUSTOM_CHANNEL_PRESET;
}

function getPresetName(value, presets) {
  const current = String(value || '').trim();
  const items = Array.isArray(presets) ? presets : normalizeChannelPresets(presets);
  return items.find((item) => item.openConversationId === current)?.name || '';
}

function getRawConversation(data) {
  const raw = Array.isArray(data) ? data[0] : (data && typeof data === 'object' ? data : {});
  const nested = Array.isArray(raw.chats)
    ? raw.chats[0]
    : (Array.isArray(raw.conversations) ? raw.conversations[0] : (raw.data && typeof raw.data === 'object' ? raw.data : null));
  return nested && typeof nested === 'object' ? { ...raw, ...nested } : raw;
}

function extractDingtalkConversation(data) {
  const source = getRawConversation(data);
  const openConversationId = String(
    source.openConversationId || source.openCid || source.cid || source.conversationId || source.chatId || source.id || '',
  ).trim();
  const name = String(source.title || source.name || source.conversationTitle || source.groupName || '钉钉群聊').trim();
  return { openConversationId, name };
}

function isSingleConversation(data) {
  const source = getRawConversation(data);
  const typeText = String(source.type || source.chatType || source.conversationType || source.bizType || '').toLowerCase();
  if (['single', 'private', 'p2p', 'one2one', 'oto', '1'].includes(typeText)) return true;
  if (source.isGroup === false || source.group === false) return true;
  const memberCount = Number(source.memberCount || source.membersCount || source.userCount || 0);
  return memberCount > 0 && memberCount <= 2;
}

function isLikelyGroupConversation(data) {
  const source = getRawConversation(data);
  const typeText = String(source.type || source.chatType || source.conversationType || source.bizType || '').toLowerCase();
  if (['group', 'enterprise_group', 'org_group', '2'].includes(typeText)) return true;
  if (source.isGroup === true || source.group === true) return true;
  const memberCount = Number(source.memberCount || source.membersCount || source.userCount || 0);
  return memberCount > 2;
}

function assertGroupConversation(data) {
  if (isSingleConversation(data)) throw new Error('不能选择单聊，请选择群聊');
  if (isLikelyGroupConversation(data)) return;
  throw new Error('钉钉返回内容无法确认是群聊，未保存');
}

function withTimeout(promise, ms, message) {
  let timer = 0;
  return Promise.race([
    promise.finally(() => window.clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = window.setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

const variableDescriptions = {
  name: '接收消息的用户姓名',
  userid: '接收消息的钉钉 Userid',
  reason: '发币或减币的业务原因',
  amount: '本次变动的 BOB 币数量',
  balance: '操作完成后的账户余额',
  exchange_id: '订单或核销单号',
  transfer_id: '转账流水编号',
  product_name: '商品名称',
  to_name: '转账接收人姓名',
  from_name: '转账发起人姓名',
  activity_id: '红包活动编号',
  project_name: '公益项目名称',
  title: '群消息标题',
  content: '群消息正文',
  open_time: '商城开启时间',
  close_time: '商城关闭时间',
  stock: '商品当前库存',
};

function parseTemplateVars(vars) {
  const keys = Array.from(String(vars || '').matchAll(/\{\{([^}]+)\}\}/g)).map((m) => m[1]).filter(Boolean);
  return keys;
}

function collectTemplateVars(templates) {
  const seen = new Set();
  const keys = [];
  templates.forEach((item) => {
    parseTemplateVars(item.vars).forEach((key) => {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    });
  });
  return keys;
}

function renderVariableHelp(keys, onInsert, canEdit) {
  if (!keys.length) return null;
  return <div className="template-variable-help">
    <Typography.Text type="secondary">{canEdit ? '模板变量（点击插入到当前编辑框）' : '模板变量'}</Typography.Text>
    <div className="template-variable-grid">
      {keys.map((key) => <div className="template-variable-item" key={key}>
        {canEdit
          ? <button type="button" className="template-variable-chip" onClick={() => onInsert?.(key)}><code>{`{{${key}}}`}</code></button>
          : <code>{`{{${key}}}`}</code>}
        <span>{variableDescriptions[key] || '模板变量'}</span>
      </div>)}
    </div>
  </div>;
}

function Toolbar({ onRefresh, onReset, onSave, canEdit = true }) {
  return <Space className="table-toolbar" wrap>
    <Button onClick={onRefresh}>刷新</Button>
    {canEdit && <Button danger onClick={onReset}>恢复默认</Button>}
    {canEdit && <Button type="primary" onClick={onSave}>保存</Button>}
  </Space>;
}

function TemplateFields({ namePrefix, withButtons = false, canEdit = true, onActiveField }) {
  const bindField = (name) => {
    const updateTarget = (event) => onActiveField?.({
      namePath: [...namePrefix, name],
      start: event?.target?.selectionStart ?? null,
      end: event?.target?.selectionEnd ?? null,
    });
    return { onFocus: updateTarget, onClick: updateTarget, onKeyUp: updateTarget, onSelect: updateTarget };
  };
  return <Space direction="vertical" style={{ width: '100%' }} size={12}>
    <Form.Item label="启用" name={[...namePrefix, 'enabled']} valuePropName="checked"><Switch disabled={!canEdit} /></Form.Item>
    <Form.Item label="标题" name={[...namePrefix, 'title']} rules={[{ required: true, message: '请输入标题' }]}><Input readOnly={!canEdit} className={!canEdit ? 'readonly-input' : ''} {...bindField('title')} /></Form.Item>
    <Form.Item label="正文" name={[...namePrefix, 'content']} rules={[{ required: true, message: '请输入正文' }]}><Input.TextArea rows={6} readOnly={!canEdit} className={!canEdit ? 'readonly-input' : ''} {...bindField('content')} /></Form.Item>
    {withButtons && <>
      <Divider style={{ margin: '4px 0' }} />
      <Form.List name={[...namePrefix, 'buttons']}>
        {(fields, { add, remove }) => <Space direction="vertical" style={{ width: '100%' }} size={10}>
          <Space><Typography.Text strong>按钮</Typography.Text>{canEdit && <Button onClick={() => add({ text: '', url: '', color: 'blue' })}>新增按钮</Button>}</Space>
          {fields.map((field) => <Card size="small" key={field.key}>
            <Space direction="vertical" style={{ width: '100%' }}>
              <Form.Item label="按钮文字" name={[field.name, 'text']} rules={[{ required: true, message: '请输入按钮文字' }]}><Input readOnly={!canEdit} /></Form.Item>
              <Form.Item label="跳转链接" name={[field.name, 'url']} rules={[{ required: true, message: '请输入跳转链接' }]}><Input readOnly={!canEdit} /></Form.Item>
              <Form.Item label="颜色" name={[field.name, 'color']}><Select disabled={!canEdit} options={colorOptions} /></Form.Item>
              {canEdit && <Button danger onClick={() => remove(field.name)}>删除按钮</Button>}
            </Space>
          </Card>)}
        </Space>}
      </Form.List>
    </>}
  </Space>;
}

function SettingsEditor({ title, loadPath, savePath, templates, withChannel = false, withButtons = false, canEdit = true, topPanel = null, extraPanel = null }) {
  const { message, modal } = App.useApp();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [selectingGroup, setSelectingGroup] = useState(false);
  const [presetManagerOpen, setPresetManagerOpen] = useState(false);
  const [channelEditing, setChannelEditing] = useState(false);
  const [channelPresets, setChannelPresets] = useState(defaultGroupConversationPresets);
  const [selectedChannelPreset, setSelectedChannelPreset] = useState(CUSTOM_CHANNEL_PRESET);
  const [inDingtalk, setInDingtalk] = useState(false);
  const [activeField, setActiveField] = useState(null);
  const channelPresetOptions = useMemo(() => buildConversationPresetOptions(channelPresets), [channelPresets]);

  const setChannelOpenConversationId = (value) => {
    const currentChannel = form.getFieldValue('channel') || {};
    form.setFieldsValue({
      channel: {
        ...currentChannel,
        openConversationId: value || null,
      },
    });
  };

  const load = async () => {
    setLoading(true);
    try {
      const data = await api(loadPath);
      const nextData = data.data || {};
      form.setFieldsValue(nextData);
      if (withChannel) {
        const currentChannelId = nextData?.channel?.openConversationId;
        const presets = normalizeChannelPresets(nextData.channelPresets, currentChannelId, nextData.channelPresetsEmpty === true);
        const selectedPreset = matchConversationPreset(currentChannelId, presets, true);
        setChannelPresets(presets);
        setSelectedChannelPreset(selectedPreset);
        if (selectedPreset !== CUSTOM_CHANNEL_PRESET) {
          setChannelOpenConversationId(selectedPreset);
        }
      }
      setChannelEditing(false);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load().catch((e) => message.error(e.message)); }, []);
  useEffect(() => { setInDingtalk(isDingtalkClient()); }, []);

  const save = async () => {
    await form.validateFields();
    const payload = form.getFieldsValue(true);
    if (withChannel) {
      payload.channelPresets = channelPresets;
      payload.channelPresetsEmpty = channelPresets.length === 0;
      payload.channel = { ...(payload.channel || {}) };
      if (selectedChannelPreset !== CUSTOM_CHANNEL_PRESET) {
        payload.channel.openConversationId = selectedChannelPreset;
      } else {
        payload.channel.openConversationId = String(payload.channel.openConversationId || '').trim() || null;
      }
    }
    await api(savePath, { method: 'POST', body: payload });
    message.success(`${title}已保存`);
    setChannelEditing(false);
    load();
  };

  const reset = async () => {
    await api(savePath, { method: 'POST', body: { reset: true } });
    message.success('已恢复默认');
    load();
  };

  const selectChannelPreset = (value) => {
    setSelectedChannelPreset(value);
    if (value === CUSTOM_CHANNEL_PRESET) {
      setChannelEditing(true);
      return;
    }
    setChannelOpenConversationId(value);
    setChannelEditing(false);
  };

  const persistChannelPresets = async (nextPresets, nextChannelId) => {
    const payload = form.getFieldsValue(true);
    payload.channelPresets = nextPresets;
    payload.channelPresetsEmpty = nextPresets.length === 0;
    if (nextChannelId !== undefined) {
      payload.channel = { ...(payload.channel || {}), openConversationId: nextChannelId || null };
      setChannelOpenConversationId(nextChannelId || null);
    }
    const saved = await api(savePath, { method: 'POST', body: payload });
    const savedData = saved.data || payload;
    const presets = normalizeChannelPresets(savedData.channelPresets, savedData?.channel?.openConversationId, savedData.channelPresetsEmpty === true);
    setChannelPresets(presets);
    setSelectedChannelPreset(matchConversationPreset(savedData?.channel?.openConversationId, presets, true));
    setChannelEditing(false);
  };

  const removeChannelPreset = async (preset) => {
    const ok = await new Promise((resolve) => {
      modal.confirm({
        title: '删除群预设？',
        content: `删除“${preset.name}”后不会删除钉钉群，只会从后台预设列表移除。`,
        okText: '删除',
        cancelText: '取消',
        okButtonProps: { danger: true },
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
    if (!ok) return;
    const nextPresets = channelPresets.filter((item) => item.openConversationId !== preset.openConversationId);
    const currentId = form.getFieldValue(['channel', 'openConversationId']);
    const nextChannelId = currentId === preset.openConversationId ? (nextPresets[0]?.openConversationId || '') : undefined;
    await persistChannelPresets(nextPresets, nextChannelId);
    message.success('群预设已删除');
  };

  const chooseDingtalkGroup = async () => {
    if (!canEdit) return;
    if (!isDingtalkClient()) {
      message.info('请在钉钉客户端内打开后台后再选择群聊');
      return;
    }
    setSelectingGroup(true);
    try {
      const { dd, cfg } = await initDingtalkJsapi(['biz.chat.pickConversation', 'biz.chat.chooseConversationByCorpId']);
      if (!dd?.biz?.chat?.pickConversation && !dd?.biz?.chat?.chooseConversationByCorpId) {
        throw new Error('当前钉钉版本不支持选择群聊，请升级钉钉客户端');
      }
      const selected = await withTimeout(new Promise((resolve, reject) => {
        const options = {
          corpId: cfg.corpId,
          isConfirm: true,
          max: 1,
          multiple: false,
          onSuccess: (data) => resolve(data),
          onFail: (err) => reject(new Error(err?.errorMessage || err?.message || '未选择群聊')),
        };
        if (dd?.biz?.chat?.pickConversation) {
          dd.biz.chat.pickConversation({
            ...options,
            onlyGroup: true,
            conversationTypes: ['group'],
            onSuccess: (data) => resolve(data),
          });
          return;
        }
        dd.biz.chat.chooseConversationByCorpId({
          ...options,
          onlyGroup: true,
          conversationTypes: ['group'],
        });
      }), 20000, '钉钉选择群聊超时，请重新选择');
      assertGroupConversation(selected);
      const conversation = extractDingtalkConversation(selected);
      if (!conversation.openConversationId) throw new Error('钉钉没有返回群会话 ID');
      const presetName = String(conversation.name || '').trim() || '钉钉群聊';
      const conversationMeta = getRawConversation(selected);
      const data = await api('/admin/settings/group-card/preset', {
        method: 'POST',
        body: {
          name: presetName,
          openConversationId: conversation.openConversationId,
          conversationType: conversationMeta.type || conversationMeta.chatType || conversationMeta.conversationType || conversationMeta.bizType || '',
          isGroup: conversationMeta.isGroup ?? conversationMeta.group ?? null,
          memberCount: conversationMeta.memberCount || conversationMeta.membersCount || conversationMeta.userCount || null,
        },
      });
      const nextPresets = normalizeChannelPresets(data?.data?.channelPresets, conversation.openConversationId);
      setChannelPresets(nextPresets);
      setSelectedChannelPreset(conversation.openConversationId);
      setChannelOpenConversationId(conversation.openConversationId);
      setChannelEditing(false);
      message.success('群聊已保存为预设');
    } catch (err) {
      if (String(err?.message || '') !== 'cancel') message.error(err.message || '选择群聊失败');
    } finally {
      setSelectingGroup(false);
    }
  };

  const checkGroupCardConfig = async () => {
    const hide = message.loading('正在检测群卡配置…', 0);
    setChecking(true);
    try {
      const data = await api('/admin/settings/group-card/check');
      const result = data.data || {};
      const items = Array.isArray(result.items) ? result.items : [];
      modal.info({
        title: result.ok ? '群卡配置可用' : '群卡配置需要补全',
        width: 640,
        okText: '知道了',
        content: <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text type="secondary">{result.note || '检测不发送真实消息。'}</Typography.Text>
          <div className="group-channel-check-list">
            {items.map((item) => <div key={item.key} className={`group-channel-check-item ${item.ok ? 'is-ok' : 'is-fail'}`}>
              <span>{item.label}</span>
              <b>{item.ok ? '正常' : '缺失或不可用'}</b>
              {item.message ? <Typography.Text type="secondary">{item.message}</Typography.Text> : null}
            </div>)}
          </div>
        </Space>,
      });
    } catch (err) {
      modal.error({
        title: '检测失败',
        okText: '知道了',
        content: err.message || '检测接口没有返回结果，请刷新后重试。',
      });
    } finally {
      hide?.();
      setChecking(false);
    }
  };
  const insertVariable = (key) => {
    if (!activeField) {
      message.warning('请先点击标题或正文编辑框');
      return;
    }
    const token = `{{${key}}}`;
    const current = String(form.getFieldValue(activeField.namePath) || '');
    const start = Number.isInteger(activeField.start) ? activeField.start : current.length;
    const end = Number.isInteger(activeField.end) ? activeField.end : start;
    form.setFieldValue(activeField.namePath, `${current.slice(0, start)}${token}${current.slice(end)}`);
    setActiveField({ ...activeField, start: start + token.length, end: start + token.length });
  };

  const selectedPresetName = getPresetName(selectedChannelPreset, channelPresets);

  const items = templates.map((item) => ({
    key: item.key,
    label: item.label,
    children: <TemplateFields namePrefix={['templates', item.key]} withButtons={withButtons} canEdit={canEdit} onActiveField={setActiveField} />,
  }));
  const templateVars = collectTemplateVars(templates);

  return <Card loading={loading}>
    <Toolbar onRefresh={load} onReset={reset} onSave={save} canEdit={canEdit} />
    {topPanel}
    <Form form={form} layout="vertical">
      <Form.Item label="总开关" name="enabled" valuePropName="checked"><Switch disabled={!canEdit} /></Form.Item>
      {renderVariableHelp(templateVars, insertVariable, canEdit)}
      {withChannel && <Card
        size="small"
        title="群发送配置"
        extra={canEdit ? <Button onClick={() => setChannelEditing((v) => !v)}>{channelEditing ? '锁定配置' : '编辑配置'}</Button> : null}
        style={{ marginBottom: 12 }}
      >
        <Alert
          type="info"
          showIcon
          className="group-channel-config-help"
          message="日常只需要选择群预设"
          description={inDingtalk
            ? '当前在钉钉客户端内打开，可以直接选择群聊并保存为群预设。复杂 ID 已收进高级配置，只有换模板时才需要维护。'
            : '普通浏览器保留群预设；在钉钉客户端内打开后台后，可以直接选择群聊并保存为群预设。'}
        />
        <div className="group-channel-config-grid group-channel-basic-grid">
          <Form.Item label="群会话预设" className="group-channel-span-2">
            <Select disabled={!canEdit} value={selectedChannelPreset} options={channelPresetOptions} onChange={selectChannelPreset} />
            <Typography.Text type="secondary" className="group-channel-current">
              {selectedChannelPreset === CUSTOM_CHANNEL_PRESET ? '当前为自定义群，请在高级配置里填写群会话 ID。' : `当前选择：${selectedPresetName || '群预设'}`}
            </Typography.Text>
          </Form.Item>
          <div className="group-channel-actions">
            {inDingtalk
              ? <Button type="primary" htmlType="button" onClick={chooseDingtalkGroup} loading={selectingGroup} disabled={!canEdit}>从钉钉选择群聊</Button>
              : <Typography.Text type="secondary">钉钉客户端内可选择群聊</Typography.Text>}
            {canEdit && <Button htmlType="button" onClick={() => setPresetManagerOpen(true)}>管理预设</Button>}
            <Button htmlType="button" onClick={checkGroupCardConfig} loading={checking}>检测配置</Button>
          </div>
          <Form.Item label="全员广播" name={['channel', 'broadcastAll']} valuePropName="checked"><Switch disabled={!channelEditing} /></Form.Item>
          <Form.Item label="指定接收人" name={['channel', 'recipients']} className="group-channel-span-2"><Input.TextArea readOnly={!channelEditing} className={!channelEditing ? 'readonly-input' : ''} rows={2} placeholder="不填时按默认接收人；多个 Userid 可用换行或逗号分隔" /></Form.Item>
        </div>
        <Collapse
          className="group-channel-advanced"
          ghost
          items={[{
            key: 'advanced',
            label: '高级配置：群 ID、模板和字段映射',
            forceRender: true,
            children: <div className="group-channel-config-grid">
              <Form.Item label="群会话 ID" name={['channel', 'openConversationId']} className="group-channel-span-2"><Input readOnly={!channelEditing || selectedChannelPreset !== CUSTOM_CHANNEL_PRESET} className={!channelEditing || selectedChannelPreset !== CUSTOM_CHANNEL_PRESET ? 'readonly-input' : ''} placeholder={selectedChannelPreset === CUSTOM_CHANNEL_PRESET ? '填写钉钉群 openConversationId' : '已从预设自动填入'} /></Form.Item>
              <Form.Item label="操作人 Userid" name={['channel', 'operatorUserid']}><Input readOnly={!channelEditing} className={!channelEditing ? 'readonly-input' : ''} /></Form.Item>
              <Form.Item label="卡片模板 ID" name={['channel', 'cardTemplateId']} className="group-channel-span-2"><Input readOnly={!channelEditing} className={!channelEditing ? 'readonly-input' : ''} /></Form.Item>
              <Form.Item label="搜索图标" name={['channel', 'searchIcon']}><Input readOnly={!channelEditing} className={!channelEditing ? 'readonly-input' : ''} placeholder="可选，填写图标地址" /></Form.Item>
              <Form.Item label="标题字段 Key" name={['channel', 'titleKey']}><Input readOnly={!channelEditing} className={!channelEditing ? 'readonly-input' : ''} placeholder="留空使用默认标题字段" /></Form.Item>
              <Form.Item label="内容字段 Key" name={['channel', 'contentKey']}><Input readOnly={!channelEditing} className={!channelEditing ? 'readonly-input' : ''} placeholder="例如 spyj_neirong" /></Form.Item>
            </div>,
          }]}
        />
      </Card>}
      <Collapse defaultActiveKey={[]} items={items} />
    </Form>
    {withChannel && <Modal
      title="管理群预设"
      open={presetManagerOpen}
      onCancel={() => setPresetManagerOpen(false)}
      footer={<Button onClick={() => setPresetManagerOpen(false)}>关闭</Button>}
      width={640}
    >
      {channelPresets.length ? <div className="group-channel-preset-list">
        {channelPresets.map((preset) => <div className="group-channel-preset-item" key={preset.openConversationId}>
          <div>
            <Typography.Text strong>{preset.name}</Typography.Text>
            <Typography.Text type="secondary">已保存为后台群预设</Typography.Text>
          </div>
          <Button danger size="small" onClick={() => removeChannelPreset(preset)} disabled={!canEdit}>删除</Button>
        </div>)}
      </div> : <Alert type="info" showIcon message="暂无群预设" description="可以在钉钉客户端内选择群聊后保存为预设。" />}
    </Modal>}
    {extraPanel}
  </Card>;
}


function NotifyTestPanel({ disabled, canSearchUsers }) {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [userOptions, setUserOptions] = useState([]);
  const searchUsers = async (keyword) => {
    if (!String(keyword || '').trim()) return;
    const data = await api(`/admin/users?${qs({ keyword, page: 1, pageSize: 20 })}`);
    setUserOptions((data.data || []).map((row) => ({ value: row.userid, label: row.name ? `${row.name}（${row.userid}）` : row.userid, name: row.name || '' })));
  };
  const submit = async (values) => {
    setLoading(true);
    try {
      await api('/admin/settings/notify/test', { method: 'POST', body: values });
      message.success('私聊测试已发送');
    } catch (err) {
      message.error(err.message || '私聊测试失败');
    } finally {
      setLoading(false);
    }
  };
  return <Card size="small" title="私聊测试" style={{ margin: '12px 0' }}>
    <Form form={form} layout="inline" onFinish={submit} className="notify-test-form">
      <Form.Item name="event" rules={[{ required: true, message: '请选择事件' }]}><Select placeholder="选择通知类型" style={{ width: 180 }} options={notifyTemplates.map((item) => ({ value: item.key, label: item.label }))} /></Form.Item>
{canSearchUsers ? <Form.Item name="userid" rules={[{ required: true, message: '请选择测试用户' }]}><Select showSearch placeholder="搜索并选择内部测试用户" style={{ width: 280 }} filterOption={false} onSearch={searchUsers} options={userOptions} onChange={(userid, option) => form.setFieldsValue({ userid, name: option?.name || '' })} /></Form.Item> : <Form.Item name="userid" rules={[{ required: true, message: '请输入测试用户 Userid' }]}><Input placeholder="内部测试用户 Userid" style={{ width: 220 }} /></Form.Item>}
      <Form.Item name="name"><Input placeholder={canSearchUsers ? "用户姓名" : "可选：用户姓名"} style={{ width: 160 }} readOnly={canSearchUsers} /></Form.Item>
      <Button type="primary" htmlType="submit" loading={loading} disabled={disabled}>发送测试</Button>
    </Form>
  </Card>;
}

function GroupCardActions({ canManual, canTest }) {
  const { message } = App.useApp();
  const [testForm] = Form.useForm();
  const [manualForm] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const confirmRun = (title, content, fn) => Modal.confirm({ title, content, okText: '确认发送', cancelText: '取消', onOk: fn });
  const testSend = async (values) => confirmRun('确认发送群卡测试？', '这会向当前配置的测试群或群会话发送一条测试群卡。', async () => {
    setLoading(true);
    try {
      await api('/admin/settings/group-card/test', { method: 'POST', body: values });
      message.success('群卡测试已发送');
    } catch (err) {
      message.error(err.message || '群卡测试失败');
    } finally {
      setLoading(false);
    }
  });
  const manualSend = async (values) => {
    if (!String(values.title || '').trim() && !String(values.markdown || '').trim()) {
      message.warning('标题和内容至少填写一项');
      return;
    }
    const linkUrl = String(values.linkUrl || '').trim();
    const buttons = Array.isArray(values.buttons)
      ? values.buttons.map((item) => ({
        ...item,
        text: String(item?.text || '').trim(),
        url: String(item?.url || '').trim(),
      })).filter((item) => item.text && item.url)
      : [];
    const payload = {
      ...values,
      buttons: buttons.length ? buttons : linkUrl ? [{ text: '查看详情', url: linkUrl, color: 'blue' }] : undefined,
    };
    return confirmRun('确认发送手动群卡？', '这会向当前群卡配置对应的群发送手动群卡，请确认内容和群会话无误。', async () => {
    setLoading(true);
    try {
      await api('/admin/notify/group-card', { method: 'POST', body: payload });
      message.success('手动群卡已发送');
      manualForm.resetFields();
    } catch (err) {
      message.error(err.message || '手动群卡发送失败');
    } finally {
      setLoading(false);
    }
  });
  };
  return <Space direction="vertical" style={{ width: '100%', marginTop: 12 }} size={12}>
    <Card size="small" title="群卡模板测试">
      <Form form={testForm} layout="inline" onFinish={testSend}>
        <Form.Item name="event" initialValue="manual"><Select style={{ width: 200 }} options={groupTemplates.map((item) => ({ value: item.key, label: item.label }))} /></Form.Item>
        <Button type="primary" htmlType="submit" loading={loading} disabled={!canTest}>发送模板测试</Button>
      </Form>
    </Card>
    <Card size="small" title="手动群卡推送">
      <Form form={manualForm} layout="vertical" onFinish={manualSend} className="group-card-manual-form">
        <div className="group-card-manual-grid">
          <Form.Item label="标题" name="title" className="group-card-span-2"><Input readOnly={!canManual} /></Form.Item>
          <Form.Item label="外部追踪 ID" name="outTrackId"><Input placeholder="可选，留空自动生成" readOnly={!canManual} /></Form.Item>
          <Form.Item label="Markdown 内容" name="markdown" className="group-card-span-all"><Input.TextArea rows={4} readOnly={!canManual} /></Form.Item>
          <Form.Item label="图片地址" name="imageUrl"><Input placeholder="可选" readOnly={!canManual} /></Form.Item>
          <Form.Item label="快捷链接" name="linkUrl" className="group-card-span-2"><Input placeholder="可选；未配置按钮时自动生成“查看详情”按钮" readOnly={!canManual} /></Form.Item>
        </div>
        <Form.List name="buttons">
          {(fields, { add, remove }) => <div className="group-card-button-section">
            <div className="group-card-button-header"><Typography.Text strong>按钮</Typography.Text>{canManual && <Button onClick={() => add({ text: '', url: '', color: 'blue' })}>新增按钮</Button>}</div>
            {fields.map((field) => <Card size="small" key={field.key} className="group-card-button-card">
              <div className="group-card-button-grid">
                <Form.Item label="按钮文字" name={[field.name, 'text']} rules={[{ required: true, message: '请输入按钮文字' }]}><Input readOnly={!canManual} /></Form.Item>
                <Form.Item label="跳转链接" name={[field.name, 'url']} rules={[{ required: true, message: '请输入跳转链接' }]} className="group-card-span-2"><Input readOnly={!canManual} /></Form.Item>
                <Form.Item label="颜色" name={[field.name, 'color']}><Select disabled={!canManual} options={colorOptions} /></Form.Item>
                {canManual && <div className="group-card-button-actions"><Button danger onClick={() => remove(field.name)}>删除按钮</Button></div>}
              </div>
            </Card>)}
          </div>}
        </Form.List>
        <div className="group-card-manual-actions"><Button type="primary" htmlType="submit" loading={loading} disabled={!canManual}>发送手动群卡</Button></div>
      </Form>
    </Card>
  </Space>;
}

export default function Messages({ me }) {
  const canEdit = hasPermission(me, 'messages:edit');
  const canTest = hasPermission(me, 'messages:test');
  const canSearchUsers = hasPermission(me, 'users:view');
  return <Tabs items={[
    { key: 'notify', label: '私聊通知模板', children: <SettingsEditor title="私聊通知模板" loadPath="/admin/settings/notify" savePath="/admin/settings/notify" templates={notifyTemplates} canEdit={canEdit} topPanel={<NotifyTestPanel disabled={!canTest} canSearchUsers={canSearchUsers} />} /> },
    { key: 'group', label: '群卡片模板', children: <SettingsEditor title="群卡片模板" loadPath="/admin/settings/group-card" savePath="/admin/settings/group-card" templates={groupTemplates} withChannel withButtons canEdit={canEdit} extraPanel={<GroupCardActions canManual={canEdit} canTest={canTest} />} /> },
  ]} />;
}
