const getRtcConfig = () => {
  return {
    host: process.env.PEER_HOST || "/",
    port: process.env.PEER_PORT || "",
    path: "/peerjs",
    secure: process.env.PEER_SECURE === "true",
  };
};

module.exports = { getRtcConfig };
