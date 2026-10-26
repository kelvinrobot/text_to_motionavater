import './styles.css';
import { ApplicationController } from './applicationController';

const controller = new ApplicationController();
controller.start();

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    controller.dispose();
  });
}
