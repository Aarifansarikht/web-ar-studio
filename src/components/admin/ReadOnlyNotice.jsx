import Icon from '../common/Icon.jsx';

/** Shown when the app runs on a static host (no API): data is read-only. */
export default function ReadOnlyNotice() {
  return (
    <div className="alert alert-info" role="status">
      <Icon name="info" />
      <div>
        <strong>Read-only showcase</strong>
        This site is hosted statically, so experiences can be viewed, scanned and shared but not created or edited
        here. Edit them locally with the Node server, then run <code>npm run export:static</code> and redeploy.
      </div>
    </div>
  );
}
