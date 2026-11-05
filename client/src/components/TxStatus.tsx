import { stageLabel, TX_STAGE_ORDER, type UseRegistry } from '../hooks/useRegistry';

/** Visual representation of the transaction lifecycle state machine. */
export const TxStatus = ({ app }: { app: UseRegistry }) => {
  const { tx } = app;
  const failed = tx.stage === 'failed';
  const currentIndex = TX_STAGE_ORDER.indexOf(tx.stage);

  return (
    <div className="card">
      <div className="card-header fw-bold"><i className="bi-arrow-repeat me-2"></i>Transaction status</div>
      <div className="card-body">

        <div className="d-flex gap-2 flex-wrap">
          {TX_STAGE_ORDER.map((stage, index) => {
            let cls = 'badge bg-secondary';
            if (stage === tx.stage) cls = failed ? 'badge bg-danger' : 'badge bg-primary';
            else if (currentIndex > index && !failed) cls = 'badge bg-success';
            return (
              <span key={stage} className={cls}>
                {stageLabel[stage]}
              </span>
            );
          })}
        </div>

        {tx.message && <p className="text-muted small">{tx.message}</p>}
        {tx.error && <div className="alert alert-danger">{tx.error}</div>}
        {tx.hash && (
          <p className="text-muted small mono">
            tx: {tx.hash}
            {tx.blockNumber !== undefined && ` | block ${tx.blockNumber}`}
            {tx.gasUsed !== undefined && ` | gas ${tx.gasUsed.toString()}`}
          </p>
        )}
      </div>
    </div>
  );
};
