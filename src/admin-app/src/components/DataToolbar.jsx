import { Button, Input } from 'antd';

export default function DataToolbar({ keyword, onKeyword, onRefresh, onCreate, createText = '新增', searchPlaceholder = '搜索关键词', children }) {
  return (
    <div className="table-toolbar">
      {onKeyword && <div className="table-toolbar-search">
        <Input.Search allowClear placeholder={searchPlaceholder} value={keyword} onChange={(e) => onKeyword(e.target.value)} onSearch={onRefresh} />
      </div>}
      <div className="table-toolbar-actions">
        {children}
        <Button onClick={onRefresh}>刷新</Button>
        {onCreate && <Button type="primary" onClick={onCreate}>{createText}</Button>}
      </div>
    </div>
  );
}
