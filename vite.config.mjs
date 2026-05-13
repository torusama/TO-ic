import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  appType: "mpa",
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        baiHoc: resolve(__dirname, "pages/bai-hoc.html"),
        caNhan: resolve(__dirname, "pages/ca-nhan.html"),
        hocPhan: resolve(__dirname, "pages/hoc-phan.html"),
        hocPhanChiTiet: resolve(__dirname, "pages/hoc-phan-chi-tiet.html"),
        luyenDe: resolve(__dirname, "pages/luyen-de.html"),
        tuVung: resolve(__dirname, "pages/tu-vung.html"),
      },
    },
  },
});
