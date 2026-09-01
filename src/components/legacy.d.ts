declare module './LiveMap' {
  import type { ComponentType } from 'react';
  const LiveMap: ComponentType<{ height?: string }>;
  export default LiveMap;
}

declare module './ManagerScheduler' {
  import type { ComponentType } from 'react';
  const ManagerScheduler: ComponentType<Record<string, never>>;
  export default ManagerScheduler;
}
