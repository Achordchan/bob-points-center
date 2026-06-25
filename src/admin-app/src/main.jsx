import React from 'react';
import { createRoot } from 'react-dom/client';
import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import AdminApp from './App.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      form={{
        validateMessages: {
          required: '请填写${label}',
          types: { number: '${label}必须是数字' },
          number: { min: '${label}不能小于${min}', max: '${label}不能大于${max}' },
        },
      }}
      theme={{
        token: {
          colorPrimary: '#1677ff',
          borderRadius: 10,
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        },
        components: {
          Layout: { bodyBg: '#f5f7fb', siderBg: '#0f172a' },
          Card: { borderRadiusLG: 14 },
        },
      }}
    >
      <AntApp>
        <AdminApp />
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
);
