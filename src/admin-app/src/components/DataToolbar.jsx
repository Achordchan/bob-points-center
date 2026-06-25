import { Button, Input, Space } from 'antd';

export default function DataToolbar({ keyword, onKeyword, onRefresh, onCreate, createText = '新增', searchPlaceholder = '搜索关键词', children }) {
  return (
    <Space className="table-toolbar" wrap>
      {onKeyword && <Input.Search allowClear placeholder={searchPlaceholder} value={keyword} onChange={(e) => onKeyword(e.target.value)} onSearch={onRefresh} style={{ width: 320 }} />}
      {children}
      <Button onClick={onRefresh}>刷新</Button>
      {onCreate && <Button type="primary" onClick={onCreate}>{createText}</Button>}
    </Space>
  );
}
