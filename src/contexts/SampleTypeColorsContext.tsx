import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { supabase, database } from '../utils/supabase';

interface SampleTypeColorsContextType {
  colors: Record<string, string>;
  loading: boolean;
  refresh: () => Promise<void>;
}

const SampleTypeColorsContext = createContext<SampleTypeColorsContextType>({
  colors: {},
  loading: true,
  refresh: async () => {},
});

export const useSampleTypeColors = () => useContext(SampleTypeColorsContext);

export const SampleTypeColorsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [colors, setColors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  const fetchColors = useCallback(async () => {
    try {
      const labId = await database.getCurrentUserLabId();
      if (!labId) {
        setColors({});
        setLoading(false);
        return;
      }

      const { data, error } = await supabase
        .from('labs')
        .select('sample_type_colors')
        .eq('id', labId)
        .single();

      if (error) {
        console.warn('Could not fetch sample_type_colors:', error.message);
        setColors({});
      } else {
        setColors(data?.sample_type_colors || {});
      }
    } catch (err) {
      console.warn('Error fetching sample type colors:', err);
      setColors({});
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchColors();
  }, [fetchColors]);

  const refresh = useCallback(async () => {
    setLoading(true);
    await fetchColors();
  }, [fetchColors]);

  return (
    <SampleTypeColorsContext.Provider value={{ colors, loading, refresh }}>
      {children}
    </SampleTypeColorsContext.Provider>
  );
};

export default SampleTypeColorsContext;
