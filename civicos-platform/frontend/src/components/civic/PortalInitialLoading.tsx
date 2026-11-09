import styles from './civic.module.css';

export default function PortalInitialLoading() {
  return <section className={styles.welcome} aria-busy="true">
    <p className={styles.eyebrow}>YOUR COMMUNITY, CONNECTED.</p>
    <h1>Loading your community…</h1>
    <p role="status">Loading public information. This usually takes a moment.</p>
  </section>;
}
