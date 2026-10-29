import React from 'react';
import { createRoot } from 'react-dom/client';
import { DensityProvider } from '@connorhoehnslalom/ui-components/shared';
import { DispatchResponseFlow } from './dispatch-response-flow';
createRoot(document.getElementById('review-content')!).render(<DensityProvider density="compact"><DispatchResponseFlow/></DensityProvider>);
