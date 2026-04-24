/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: "#F59E0B",
          50: "#FEF9EC",
          100: "#FDF0CD",
          200: "#FBE09B",
          300: "#F9D069",
          400: "#F7B737",
          500: "#F59E0B",
          600: "#C47F09",
          700: "#936007",
          800: "#624004",
          900: "#312002",
        },
        accent: {
          DEFAULT: "#8B5CF6",
          50: "#F3EFFE",
          100: "#E7DFFD",
          200: "#CFBFFB",
          300: "#B79FF9",
          400: "#9F7FF7",
          500: "#8B5CF6",
          600: "#6D3AE4",
          700: "#5222C4",
          800: "#3C1993",
          900: "#261062",
        },
        surface: {
          DEFAULT: "#0F172A",
          50: "#F8FAFC",
          100: "#F1F5F9",
          200: "#E2E8F0",
          300: "#CBD5E1",
          400: "#94A3B8",
          500: "#64748B",
          600: "#475569",
          700: "#334155",
          800: "#1E293B",
          900: "#0F172A",
          950: "#020617",
        },
        success: "#10B981",
        danger: "#EF4444",
        warning: "#F59E0B",
        info: "#3B82F6",
      },
      fontFamily: {
        display: ["Orbitron", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
        body: ["JetBrains Mono", "monospace"],
      },
      fontSize: {
        "2xs": ["0.625rem", { lineHeight: "0.875rem" }],
      },
      animation: {
        "pulse-glow": "pulse-glow 2s ease-in-out infinite",
        "slide-in": "slide-in 0.2s ease-out",
        "fade-in": "fade-in 0.15s ease-out",
      },
      keyframes: {
        "pulse-glow": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.6" },
        },
        "slide-in": {
          from: { transform: "translateX(-8px)", opacity: "0" },
          to: { transform: "translateX(0)", opacity: "1" },
        },
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
      },
    },
  },
  plugins: [],
};
