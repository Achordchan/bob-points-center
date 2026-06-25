import { Button, Input, Space } from 'antd';

export default function DataToolbar({ keyword, onKeyword, onRefresh, onCreate, createText = '新增', children }) {
  return (
    <Space className="table-toolbar" wrap>
      {onKeyword && <Input.Search allowClear placeholder="搜索关键词" value={keyword} onChange={(e) => onKeyword(e.target.value)} onSearch={onRefresh} style={{ width: 260 }} />}
      {children}
      <Button onClick={onRefresh}>刷新</Button>
      {onCreate && <Button type="primary" onClick={onCreate}>{createText}</Button>}
    </Space>
  );
}
