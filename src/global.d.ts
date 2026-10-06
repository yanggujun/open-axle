// Ambient module declarations for non-code assets imported for their side effects.
// These allow `tsc` to type-check imports like `import './styles.css';` that are
// actually handled at bundle time by webpack (css-loader/style-loader, asset modules).

declare module '*.css';
declare module '*.scss';
declare module '*.sass';
declare module '*.less';

declare module '*.png';
declare module '*.jpg';
declare module '*.jpeg';
declare module '*.gif';
declare module '*.svg';
declare module '*.webp';
declare module '*.ico';

declare module '*.woff';
declare module '*.woff2';
declare module '*.ttf';
declare module '*.eot';
