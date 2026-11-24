import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Descriptions,
  Modal,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { api, qs } from '../../api.js';
import { hasPermission } from '../../permissions.js';
import { amountText } from '../../utils.js';
import DrawModal from './DrawModal.jsx';
import { galaErrorText } from './errors.js';

const PAGE_SIZE = 200;

// 兼容普通管理员（failed_count / failed_reasons）与超管（failed 数组），
// 只汇总数量与错误原因，不展示任何逐人或 is_reserved 信息。
function summarizeGrantFailures(data) {
  const reasons = {};
  let failedCount = 0;

  if (Array.isArray(data?.failed)) {
    for (const item of data.failed) {
      const code = String(item?.error || 'award_failed');
      reasons[code] = (reasons[code] || 0) + 1;
      failedCount += 1;
    }
    return { failedCount, reasons };
  }

  const rawReasons = data?.failed_reasons && typeof data.failed_reasons === 'object'
    ? data.failed_reasons
    : {};
  for (const [code, count] of Object.entries(rawReasons)) {
    const n = Number(count || 0);
    if (n > 0) {
      reasons[code] = n;
      failedCount += n;
    }
  }
  const reportedCount = Number(data?.failed_count || 0);
  if (Number.isFinite(reportedCount) && reportedCount > failedCount) {
    failedCount = reportedCount;
  }
  return { failedCount, reasons };
}

export default function RoundsTab({
  eventId,
  detail,
  galaVersion,
  segments = [],
  me,
  reload,
  handleError,
}) {
  const { message, modal } = AntApp.useApp();
  const canOperate = hasPermission(me, 'gala:operate');

  const [rounds, setRounds] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  const [drawModalOpen, setDrawModalOpen] = useState(false);
  const [drawResult, setDrawResult] = useState(null);
  const [grantingRoundId, setGrantingRoundId] = useState(null);
  const [partialGrantNotice, setPartialGrantNotice] = useState(null);
  const [nextRoundNoOverrides, setNextRoundNoOverrides] = useState({});

  const requestSeqRef = useRef(0);

  // 只映射公开奖池（is_reserved === 0），绝不展示预留奖池信息
  const publicPoolMap = useMemo(() => {
    const pools = (Array.isArray(detail?.pools) ? detail.pools : []).filter(
      (pool) => Number(pool?.is_reserved) === 0,
    );
    return new Map(pools.map((pool) => [Number(pool.id), pool]));
  }, [detail?.pools]);

  const loadRounds = useCallback(async () => {
    if (!eventId) return;
    const seq = ++requestSeqRef.current;
    setLoading(true);
    try {
      const resp = await api(`/admin/gala/rounds?${qs({ event_id: eventId, limit: PAGE_SIZE })}`);
      if (seq !== requestSeqRef.current) return;
      const list = Array.isArray(resp?.data) ? resp.data : [];
      setRounds(list);
      setHasMore(list.length >= PAGE_SIZE);
    } catch (err) {
      if (seq !== requestSeqRef.current) return;
      handleError(err);
    } finally {
      if (seq === requestSeqRef.current) setLoading(false);
    }
  }, [eventId, handleError]);

  const loadMore = async () => {
    if (loading || loadingMore || !hasMore || rounds.length === 0) return;
    const lastId = rounds[rounds.length - 1]?.id;
    if (!lastId) return;
    const seq = requestSeqRef.current;
    setLoadingMore(true);
    try {
      const resp = await api(
        `/admin/gala/rounds?${qs({ event_id: eventId, before_id: lastId, limit: PAGE_SIZE })}`,
      );
      if (seq !== requestSeqRef.current) return;
      const list = Array.isArray(resp?.data) ? resp.data : [];
      setRounds((prev) => {
        const seen = new Set(prev.map((item) => item.id));
        const appended = list.filter((item) => !seen.has(item.id));
        return [...prev, ...appended];
      });
      setHasMore(list.length >= PAGE_SIZE);
    } catch (err) {
      if (seq !== requestSeqRef.current) return;
      const versionChanged = handleError(err);
      if (versionChanged) loadRounds();
    } finally {
      if (seq === requestSeqRef.current) setLoadingMore(false);
    }
  };

  useEffect(() => {
    setRounds([]);
    setHasMore(false);
    setNextRoundNoOverrides({});
    setPartialGrantNotice(null);
    loadRounds();
  }, [eventId, galaVersion, loadRounds]);

  const getNextRoundNo = useCallback(
    (segmentKey) => {
      if (!segmentKey) return 1;
      let maxRoundNo = 0;
      for (const item of rounds) {
        if (item.segment === segmentKey) {
          const no = Number(item.round_no || 0);
          if (no > maxRoundNo) maxRoundNo = no;
        }
      }
      const override = Number(nextRoundNoOverrides[segmentKey] || 0);
      return Math.max(maxRoundNo + 1, override);
    },
    [rounds, nextRoundNoOverrides],
  );

  const handleRoundNoChanged = useCallback((segmentKey, nextNo) => {
    setNextRoundNoOverrides((prev) => ({
      ...prev,
      [segmentKey]: nextNo,
    }));
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([loadRounds(), reload()]);
  }, [loadRounds, reload]);

  const handleDrawSuccess = useCallback(
    async (data) => {
      setDrawModalOpen(false);
      if (data?.segment) {
        setNextRoundNoOverrides((prev) => {
          if (!Object.hasOwn(prev, data.segment)) return prev;
          const next = { ...prev };
          delete next[data.segment];
          return next;
        });
      }
      setDrawResult(data);
      await refreshAll();
    },
    [refreshAll],
  );

  const handleGrant = (record) => {
    const winnersCount = Number(
      record.draw_count || (Array.isArray(record.winners) ? record.winners.length : 0),
    );
    const amountEach = Number(record.amount_each || 0);
    const totalAmount = winnersCount * amountEach;
    const poolName = record.pool_id
      ? (publicPoolMap.get(Number(record.pool_id))?.name || `奖池 #${record.pool_id}`)
      : '-';
    const segLabel = record.segment_label || record.segment;

    modal.confirm({
      title: '确认发放 BOB 币',
      width: 460,
      okText: '确认发币',
      cancelText: '取消',
      content: (
        <Descriptions
          bordered
          size="small"
          column={1}
          style={{ marginTop: 12 }}
          items={[
            {
              key: 'round',
              label: '轮次',
              children: `${segLabel} · 第 ${record.round_no} 轮${record.title ? `（${record.title}）` : ''}`,
            },
            { key: 'count', label: '发放人数', children: `${winnersCount} 人` },
            { key: 'each', label: '每人金额', children: amountText(amountEach) },
            { key: 'total', label: '发放总额', children: amountText(totalAmount) },
            { key: 'pool', label: '扣除奖池', children: poolName },
          ]}
        />
      ),
      onOk: async () => {
        setGrantingRoundId(record.id);
        try {
          const resp = await api('/admin/gala/rounds/grant', {
            method: 'POST',
            body: {
              round_id: record.id,
              grant_token: record.grant_token,
            },
          });
          const data = resp?.data || {};
          const pending = Number(data.pending || 0);
          if (pending > 0) {
            const { failedCount, reasons } = summarizeGrantFailures(data);
            message.warning(`部分发放：还有 ${pending} 人待发，可再次点击发币重试`);
            setPartialGrantNotice({
              roundId: record.id,
              label: segLabel,
              roundNo: record.round_no,
              pending,
              failedCount,
              reasons,
            });
          } else {
            message.success('本轮 BOB 币已全部发放完成');
            setPartialGrantNotice((prev) => (prev?.roundId === record.id ? null : prev));
          }
          await refreshAll();
        } catch (err) {
          const versionChanged = handleError(err);
          if (versionChanged || err?.code === 'invalid_grant_token') {
            loadRounds();
          }
        } finally {
          setGrantingRoundId(null);
        }
      },
    });
  };

  // 中奖名单只展示 name（与弹窗中的 name / userid），绝不展示 is_reserved 或其他预留相关字段。
  const columns = [
    {
      title: '环节',
      dataIndex: 'segment_label',
      width: 120,
      render: (value, record) => value || record.segment || '-',
    },
    {
      title: '轮次号',
      dataIndex: 'round_no',
      width: 90,
      render: (value) => (value ? `第 ${value} 轮` : '-'),
    },
    {
      title: '标题',
      dataIndex: 'title',
      width: 150,
      ellipsis: true,
      render: (value) => value || '-',
    },
    {
      title: '奖品类型',
      dataIndex: 'prize_type',
      width: 96,
      render: (value) => (value === 'coin' ? <Tag color="gold">发币</Tag> : <Tag>无币</Tag>),
    },
    {
      title: '单价',
      dataIndex: 'amount_each',
      width: 110,
      render: (value, record) => (record.prize_type === 'coin' ? amountText(value) : '-'),
    },
    {
      title: '奖池',
      dataIndex: 'pool_id',
      width: 140,
      ellipsis: true,
      render: (value, record) => {
        if (record.prize_type !== 'coin' || !value) return '-';
        return publicPoolMap.get(Number(value))?.name || `奖池 #${value}`;
      },
    },
    {
      title: '中奖名单',
      dataIndex: 'winners',
      width: 260,
      render: (winners) => {
        const list = Array.isArray(winners) ? winners : [];
        if (list.length === 0) return '-';
        return (
          <Space size={[4, 4]} wrap>
            {list.map((winner, index) => (
              <Tag key={winner.id || `${winner.userid}_${index}`}>
                {winner.name || winner.userid}
              </Tag>
            ))}
          </Space>
        );
      },
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 120,
      render: (value, record) => {
        if (record.prize_type !== 'coin') return <Tag>无币</Tag>;
        if (value === 'granted') return <Tag color="green">已发放</Tag>;
        return <Tag color="orange">已抽未发完</Tag>;
      },
    },
  ];

  if (canOperate) {
    columns.push({
      title: '操作',
      key: 'actions',
      fixed: 'right',
      width: 100,
      render: (_, record) => {
        if (record.prize_type !== 'coin' || record.status === 'granted') return null;
        return (
          <Button
            size="small"
            type="primary"
            loading={grantingRoundId === record.id}
            onClick={() => handleGrant(record)}
          >
            发币
          </Button>
        );
      },
    });
  }

  const totalCount = Number(detail?.round_count ?? rounds.length);
  const drawResultWinners = Array.isArray(drawResult?.winners) ? drawResult.winners : [];

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Typography.Text type="secondary">
          共 {totalCount} 轮
          {rounds.length > 0 && rounds.length < totalCount ? `（已加载 ${rounds.length} 轮）` : ''}
        </Typography.Text>
        <Space>
          <Button onClick={loadRounds} loading={loading}>
            刷新轮次
          </Button>
          {canOperate && (
            <Button type="primary" onClick={() => setDrawModalOpen(true)}>
              发起抽签
            </Button>
          )}
        </Space>
      </div>

      {partialGrantNotice && (
        <Alert
          type="warning"
          showIcon
          closable
          onClose={() => setPartialGrantNotice(null)}
          message={`部分发放（${partialGrantNotice.label} 第 ${partialGrantNotice.roundNo} 轮）：还有 ${partialGrantNotice.pending} 人待发，可再次点击发币重试`}
          description={
            partialGrantNotice.failedCount > 0 ? (
              <div>
                <div>失败共 {partialGrantNotice.failedCount} 笔：</div>
                <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
                  {Object.entries(partialGrantNotice.reasons).map(([code, count]) => (
                    <li key={code}>
                      {galaErrorText({ code })}：{count} 人
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              '仍有待发记录，可再次点击发币重试。'
            )
          }
        />
      )}

      <Table
        rowKey="id"
        loading={loading}
        dataSource={rounds}
        columns={columns}
        pagination={false}
        scroll={{ x: canOperate ? 1190 : 1090 }}
        locale={{ emptyText: '暂无抽签轮次' }}
      />

      {(rounds.length > 0 || hasMore) && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <Typography.Text type="secondary">已加载 {rounds.length} 轮</Typography.Text>
          {hasMore ? (
            <Button onClick={loadMore} loading={loadingMore}>
              加载更多
            </Button>
          ) : (
            <Typography.Text type="secondary">已显示全部轮次</Typography.Text>
          )}
        </div>
      )}

      <DrawModal
        open={drawModalOpen}
        onCancel={() => setDrawModalOpen(false)}
        eventId={eventId}
        detail={detail}
        galaVersion={galaVersion}
        segments={segments}
        getNextRoundNo={getNextRoundNo}
        onRoundNoChanged={handleRoundNoChanged}
        onSuccess={handleDrawSuccess}
        onRefreshAll={refreshAll}
        onRefreshRounds={loadRounds}
        handleError={handleError}
      />

      <Modal
        title={
          drawResult
            ? `中奖名单 - ${drawResult.segment_label || drawResult.segment} 第 ${drawResult.round_no} 轮`
            : '中奖名单'
        }
        open={Boolean(drawResult)}
        onCancel={() => setDrawResult(null)}
        footer={[
          <Button key="close" type="primary" onClick={() => setDrawResult(null)}>
            知道了
          </Button>,
        ]}
        width={560}
        destroyOnHidden
      >
        {drawResult && (
          <Space direction="vertical" style={{ width: '100%' }} size={12}>
            {drawResult.replayed === true && (
              <Alert
                type="info"
                showIcon
                message="这是之前已抽出的同一轮（重试返回），未重新抽签"
              />
            )}

            <Typography.Text type="secondary">
              {drawResult.title ? `标题：${drawResult.title} · ` : ''}
              共中奖 {drawResultWinners.length} 人
              {drawResult.prize_type === 'coin'
                ? ` · 每人 ${amountText(drawResult.amount_each)}（总额 ${amountText(Number(drawResult.amount_each || 0) * Number(drawResult.draw_count || drawResultWinners.length))}）`
                : ' · 无币轮次'}
            </Typography.Text>

            <Table
              rowKey={(item, idx) => item.id || `${item.userid}_${idx}`}
              size="small"
              pagination={false}
              dataSource={drawResultWinners}
              scroll={{ y: 360 }}
              locale={{ emptyText: '暂无中奖人' }}
              columns={[
                {
                  title: '序号',
                  key: 'index',
                  width: 64,
                  render: (_, __, index) => index + 1,
                },
                {
                  title: '姓名',
                  dataIndex: 'name',
                  render: (value, record) => value || record.userid || '-',
                },
                {
                  title: 'userid',
                  dataIndex: 'userid',
                  ellipsis: true,
                },
              ]}
            />
          </Space>
        )}
      </Modal>
    </Space>
  );
}
