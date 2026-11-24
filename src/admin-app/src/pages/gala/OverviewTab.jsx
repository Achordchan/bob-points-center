import { Card, Col, Descriptions, Row, Space, Statistic, Table, Tag } from 'antd';
import { amountText, formatTs } from '../../utils.js';
import { EVENT_STATUS_COLORS, EVENT_STATUS_LABELS } from './EventFormModal.jsx';

function creatorText(detail) {
  const name = String(detail?.created_name || '').trim();
  const userid = String(detail?.created_by || '').trim();
  if (name && userid && name !== userid) return `${name} (${userid})`;
  return name || userid || '-';
}

export default function OverviewTab({ detail, segments = [] }) {
  const budgetSummary = detail?.budget_summary || {};
  const totalBudget = Number(budgetSummary.total_budget ?? detail?.total_budget ?? 0);
  const poolsBudget = Number(budgetSummary.pools_budget || 0);
  const poolsAllocated = Number(budgetSummary.pools_allocated || 0);
  const hasPoolsSpent = budgetSummary.pools_spent !== undefined && budgetSummary.pools_spent !== null;
  const poolsSpent = hasPoolsSpent ? Number(budgetSummary.pools_spent || 0) : null;
  const participantCount = Number(detail?.participant_count || 0);
  const roundCount = Number(detail?.round_count || 0);

  // 概览只展示公开奖池（is_reserved === 0），绝不展示预留奖池。
  const publicPools = (Array.isArray(detail?.pools) ? detail.pools : []).filter(
    (pool) => Number(pool?.is_reserved) === 0,
  );

  const segmentLabelMap = new Map(segments.map((item) => [item.key, item.label]));
  const enabledSegments = Array.isArray(detail?.enabled_segments) ? detail.enabled_segments : [];

  const statCols = hasPoolsSpent
    ? { xs: 12, sm: 8, lg: 4 }
    : { xs: 12, sm: 8, md: 4 };

  const poolColumns = [
    {
      title: '奖池名称',
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

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={16}>
      <Card size="small" title="预算与进度汇总">
        <Row gutter={[16, 16]}>
          <Col {...statCols}>
            <Statistic
              title="总预算"
              value={totalBudget > 0 ? totalBudget : '不限'}
              suffix={totalBudget > 0 ? 'BOB' : undefined}
            />
          </Col>
          <Col {...statCols}>
            <Statistic title="奖池预算合计" value={poolsBudget} suffix="BOB" />
          </Col>
          <Col {...statCols}>
            <Statistic title="已分配合计" value={poolsAllocated} suffix="BOB" />
          </Col>
          {hasPoolsSpent && (
            <Col {...statCols}>
              <Statistic title="已发放合计" value={poolsSpent} suffix="BOB" />
            </Col>
          )}
          <Col {...statCols}>
            <Statistic title="参与人数" value={participantCount} suffix="人" />
          </Col>
          <Col {...statCols}>
            <Statistic title="轮次数" value={roundCount} suffix="轮" />
          </Col>
        </Row>
      </Card>

      <Card size="small" title="活动信息">
        <Descriptions
          bordered
          size="small"
          column={{ xs: 1, sm: 2, md: 3 }}
          items={[
            { key: 'id', label: '活动 ID', children: detail?.id ?? '-' },
            { key: 'date', label: '活动日期', children: detail?.event_date || '-' },
            {
              key: 'status',
              label: '状态',
              children: (
                <Tag color={EVENT_STATUS_COLORS[detail?.status] || 'default'}>
                  {EVENT_STATUS_LABELS[detail?.status] || detail?.status || '-'}
                </Tag>
              ),
            },
            {
              key: 'total_budget',
              label: '总预算',
              children: totalBudget > 0 ? amountText(totalBudget) : '不限',
            },
            { key: 'creator', label: '创建人', children: creatorText(detail) },
            { key: 'created_at', label: '创建时间', children: formatTs(detail?.created_at) },
            {
              key: 'segments',
              label: '启用环节',
              span: 3,
              children:
                enabledSegments.length > 0 ? (
                  <Space size={[6, 6]} wrap>
                    {enabledSegments.map((key) => (
                      <Tag key={key}>{segmentLabelMap.get(key) || key}</Tag>
                    ))}
                  </Space>
                ) : (
                  '-'
                ),
            },
          ]}
        />
      </Card>

      <Card size="small" title={`公开奖池（${publicPools.length}）`}>
        <Table
          rowKey="id"
          size="small"
          dataSource={publicPools}
          columns={poolColumns}
          pagination={false}
          scroll={{ x: 640 }}
          locale={{ emptyText: '暂无奖池' }}
        />
      </Card>
    </Space>
  );
}
