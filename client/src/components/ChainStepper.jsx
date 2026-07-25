// Visual horizontal stepper for a sequential approval chain (Leave requests, Attendance
// regularizations) — e.g. TL -> STL -> Assistant Manager -> Manager -> HR Admin -> Super Admin.
export default function ChainStepper({ chainLabel, currentStageName, status }) {
  const steps = chainLabel.split(' → ');
  const currentIdx = status === 'Approved' ? steps.length : status === 'Rejected' ? -1 : steps.indexOf(currentStageName);
  return (
    <div className="chain-stepper">
      {steps.map((s, i) => {
        let cls = 'chain-step';
        if (status === 'Rejected') cls += ' rejected';
        else if (i < currentIdx || status === 'Approved') cls += ' done';
        else if (i === currentIdx) cls += ' current';
        return (
          <div key={s} className={cls}>
            <div className="chain-dot">{status === 'Rejected' ? '✕' : (i < currentIdx || status === 'Approved') ? '✓' : i + 1}</div>
            <div className="chain-label">{s}</div>
            {i < steps.length - 1 && <div className="chain-line" />}
          </div>
        );
      })}
    </div>
  );
}
