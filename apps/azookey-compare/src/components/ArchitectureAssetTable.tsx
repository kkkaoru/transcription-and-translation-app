import { ARCHITECTURE_ASSET_ROWS, ARCHITECTURE_DEPENDENCIES } from "../lib/architecture-assets";

export const ArchitectureAssetTable = () => (
  <div className="architecture-inventory" data-testid="architecture-inventory">
    <section>
      <h3>依存関係</h3>
      <table>
        <thead>
          <tr>
            <th>実行体</th>
            <th>依存先</th>
            <th>用途</th>
          </tr>
        </thead>
        <tbody>
          {ARCHITECTURE_DEPENDENCIES.map((row) => (
            <tr key={`${row.from}->${row.to}`}>
              <td>{row.from}</td>
              <td>
                <code>{row.to}</code>
              </td>
              <td>{row.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
    <section>
      <h3>データ一覧</h3>
      <div className="architecture-asset-cards">
        {ARCHITECTURE_ASSET_ROWS.map((row) => (
          <article key={row.id} className="architecture-asset-card" data-asset={row.id}>
            <h4>
              {row.name}
              <span>{row.size}</span>
            </h4>
            <dl>
              <div>
                <dt>ファイル</dt>
                <dd>
                  <code>{row.file}</code>
                </dd>
              </div>
              <div>
                <dt>読む主体</dt>
                <dd>{row.reader}</dd>
              </div>
              <div>
                <dt>読み込み元</dt>
                <dd>{row.source}</dd>
              </div>
              <div>
                <dt>いつ</dt>
                <dd>{row.when}</dd>
              </div>
              <div>
                <dt>用途</dt>
                <dd>{row.uses}</dd>
              </div>
              <div>
                <dt>依存</dt>
                <dd>{row.depends}</dd>
              </div>
            </dl>
          </article>
        ))}
      </div>
    </section>
  </div>
);
