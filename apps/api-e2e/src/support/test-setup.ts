/* eslint-disable */
import axios from 'axios';

// Same defaults as global-setup, which boots the api on this port.
module.exports = async function () {
  const host = process.env.HOST ?? 'localhost';
  const port = process.env.PORT ?? '3399';
  axios.defaults.baseURL = `http://${host}:${port}`;
};
